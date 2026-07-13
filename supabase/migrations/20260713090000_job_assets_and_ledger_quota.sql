begin;

create table if not exists public.job_assets (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete restrict,
  principal_id uuid not null,
  bucket text not null check (bucket = 'generated-media'),
  object_key text not null check (length(object_key) between 1 and 1024),
  media_type text not null check (media_type in ('image', 'video')),
  mime_type text not null check (mime_type ~ '^(image|video)/[a-z0-9.+-]+$'),
  bytes bigint not null check (bytes between 1 and 10485760),
  state text not null default 'reserved'
    check (state in ('reserved', 'uploaded', 'canonical', 'deleting', 'deleted')),
  lease_version bigint not null check (lease_version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  canonical_at timestamptz,
  deleted_at timestamptz,
  unique (bucket, object_key),
  unique (job_id, object_key)
);

create index if not exists job_assets_cleanup_idx
  on public.job_assets(state, updated_at)
  where state in ('reserved', 'uploaded', 'deleting');
create index if not exists job_assets_principal_job_idx
  on public.job_assets(principal_id, job_id);

alter table public.job_assets enable row level security;
drop policy if exists job_assets_select_own on public.job_assets;
create policy job_assets_select_own on public.job_assets
  for select to authenticated using (auth.uid() = principal_id);
revoke all on table public.job_assets from public, anon, authenticated;
grant select on table public.job_assets to authenticated;
grant select, insert, update, delete on table public.job_assets to service_role;

create or replace function public.record_job_asset(
  input_job_id uuid,
  input_worker_id text,
  input_lease_version bigint,
  input_principal_id uuid,
  input_bucket text,
  input_object_key text,
  input_media_type text,
  input_mime_type text,
  input_bytes bigint,
  input_state text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_job public.jobs%rowtype;
  current_asset public.job_assets%rowtype;
  expected_prefix text;
  v_now timestamptz := clock_timestamp();
begin
  if input_job_id is null or input_principal_id is null
     or input_worker_id is null or length(input_worker_id) not between 1 and 256
     or input_lease_version is null or input_lease_version < 1
     or input_bucket <> 'generated-media'
     or input_media_type not in ('image', 'video')
     or input_mime_type !~ '^(image|video)/[a-z0-9.+-]+$'
     or input_bytes is null or input_bytes not between 1 and 10485760
     or input_state not in ('reserved', 'uploaded')
     or length(coalesce(input_object_key, '')) not between 1 and 1024 then
    raise exception 'invalid_job_asset' using errcode = '22023';
  end if;

  select * into current_job from public.jobs where id = input_job_id for update;
  if not found then
    return jsonb_build_object('recorded', false, 'reason', 'not_found');
  end if;
  if current_job.principal_id <> input_principal_id then
    return jsonb_build_object('recorded', false, 'reason', 'principal_mismatch');
  end if;
  if current_job.type <> 'chat.generation'
     or coalesce(current_job.subject->>'conversationId', '') !~*
       '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'invalid_job_asset_subject' using errcode = '22023';
  end if;
  if current_job.cancel_requested_at is not null then
    return jsonb_build_object('recorded', false, 'reason', 'cancel_requested');
  end if;
  if current_job.status not in ('leased', 'running')
     or current_job.lease_owner is distinct from input_worker_id
     or current_job.lease_version <> input_lease_version
     or current_job.lease_expires_at is null or current_job.lease_expires_at <= v_now then
    return jsonb_build_object('recorded', false, 'reason', 'stale_fence');
  end if;
  expected_prefix := input_principal_id::text || '/'
    || coalesce(current_job.subject->>'conversationId', '') || '/'
    || input_job_id::text || '/';
  if input_object_key not like (expected_prefix || '%')
     or position('..' in input_object_key) > 0 then
    raise exception 'invalid_job_asset_scope' using errcode = '22023';
  end if;

  select * into current_asset from public.job_assets
  where bucket = input_bucket and object_key = input_object_key
  for update;
  if found then
    if current_asset.job_id <> input_job_id
       or current_asset.principal_id <> input_principal_id
       or current_asset.media_type <> input_media_type
       or current_asset.mime_type <> input_mime_type
       or current_asset.bytes <> input_bytes
       or current_asset.state in ('canonical', 'deleting', 'deleted') then
      raise exception 'job_asset_idempotency_conflict' using errcode = '23505';
    end if;
    update public.job_assets
    set state = case when input_state = 'uploaded' then 'uploaded' else state end,
        lease_version = input_lease_version,
        updated_at = v_now
    where id = current_asset.id
    returning * into current_asset;
  else
    insert into public.job_assets(
      job_id, principal_id, bucket, object_key, media_type, mime_type,
      bytes, state, lease_version, created_at, updated_at
    ) values (
      input_job_id, input_principal_id, input_bucket, input_object_key,
      input_media_type, input_mime_type, input_bytes, input_state,
      input_lease_version, v_now, v_now
    ) returning * into current_asset;
  end if;
  return jsonb_build_object(
    'recorded', true, 'reason', null, 'assetId', current_asset.id,
    'state', current_asset.state, 'objectKey', current_asset.object_key
  );
end;
$$;

revoke all on function public.record_job_asset(
  uuid,text,bigint,uuid,text,text,text,text,bigint,text
) from public, anon, authenticated;
grant execute on function public.record_job_asset(
  uuid,text,bigint,uuid,text,text,text,text,bigint,text
) to service_role;

create or replace function public.settle_job_assets_on_terminal()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status not in ('completed', 'failed', 'cancelled')
     or old.status in ('completed', 'failed', 'cancelled') then
    return new;
  end if;
  if new.status = 'completed'
     and jsonb_typeof(new.result->'assetObjectKeys') = 'array' then
    update public.job_assets
    set state = 'canonical', canonical_at = clock_timestamp(), updated_at = clock_timestamp()
    where job_id = new.id
      and principal_id = new.principal_id
      and state in ('reserved', 'uploaded')
      and object_key in (
        select value from jsonb_array_elements_text(new.result->'assetObjectKeys') as key(value)
      );
  end if;
  if exists (
    select 1 from public.job_assets
    where job_id = new.id and state in ('reserved', 'uploaded', 'deleting')
  ) then
    insert into public.job_outbox(
      job_id, principal_id, topic, dedupe_key, payload, created_at, updated_at
    ) values (
      new.id, new.principal_id, 'assets.cleanup', new.id::text || ':assets.cleanup',
      jsonb_build_object('jobId', new.id), clock_timestamp(), clock_timestamp()
    ) on conflict (job_id, dedupe_key) do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists settle_job_assets_on_terminal on public.jobs;
create trigger settle_job_assets_on_terminal
after update of status, result on public.jobs
for each row execute function public.settle_job_assets_on_terminal();

create or replace function public.get_ledger_quota_status(input_principal_id uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  tokens_5h bigint := 0;
  tokens_7d bigint := 0;
  available_balance numeric := 0;
begin
  if input_principal_id is null
     or (auth.uid() is not null and auth.uid() <> input_principal_id)
     then
    raise exception 'quota_principal_forbidden' using errcode = '42501';
  end if;
  select
    coalesce(sum(case when created_at >= now() - interval '5 hours'
      then case direction when 'debit' then weighted_tokens else -weighted_tokens end else 0 end), 0),
    coalesce(sum(case when created_at >= now() - interval '7 days'
      then case direction when 'debit' then weighted_tokens else -weighted_tokens end else 0 end), 0)
  into tokens_5h, tokens_7d
  from public.ledger_entries where principal_id = input_principal_id;
  select coalesce(balance, 0) into available_balance
  from public.profiles where user_id = input_principal_id;
  return jsonb_build_object(
    'tokens5h', greatest(tokens_5h, 0),
    'tokens7d', greatest(tokens_7d, 0),
    'balance', greatest(available_balance, 0),
    'limit5h', 500000,
    'limit7d', 10000000
  );
end;
$$;

revoke all on function public.get_ledger_quota_status(uuid) from public, anon;
grant execute on function public.get_ledger_quota_status(uuid) to authenticated, service_role;

commit;
