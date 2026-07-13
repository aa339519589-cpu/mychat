begin;

alter table public.job_outbox
  add column if not exists lock_version bigint not null default 0,
  add column if not exists max_attempts integer not null default 10;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.job_outbox'::regclass
      and conname = 'job_outbox_lock_version_check'
  ) then
    alter table public.job_outbox add constraint job_outbox_lock_version_check
      check (lock_version >= 0);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.job_outbox'::regclass
      and conname = 'job_outbox_max_attempts_check'
  ) then
    alter table public.job_outbox add constraint job_outbox_max_attempts_check
      check (max_attempts between 1 and 100);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.job_outbox'::regclass
      and conname = 'job_outbox_payload_object_check'
  ) then
    alter table public.job_outbox add constraint job_outbox_payload_object_check
      check (jsonb_typeof(payload) = 'object');
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.job_assets'::regclass
      and conname = 'job_assets_state_timestamps_check'
  ) then
    alter table public.job_assets add constraint job_assets_state_timestamps_check check (
      (state = 'canonical') = (canonical_at is not null)
      and (state = 'deleted') = (deleted_at is not null)
      and not (canonical_at is not null and deleted_at is not null)
    );
  end if;
end;
$$;

create unique index if not exists jobs_id_principal_unique
  on public.jobs(id, principal_id);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.job_outbox'::regclass
      and conname = 'job_outbox_job_principal_fkey'
  ) then
    alter table public.job_outbox add constraint job_outbox_job_principal_fkey
      foreign key (job_id, principal_id) references public.jobs(id, principal_id)
      on delete cascade not valid;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.job_assets'::regclass
      and conname = 'job_assets_job_principal_fkey'
  ) then
    alter table public.job_assets add constraint job_assets_job_principal_fkey
      foreign key (job_id, principal_id) references public.jobs(id, principal_id)
      on delete restrict not valid;
  end if;
end;
$$;

alter table public.job_outbox validate constraint job_outbox_job_principal_fkey;
alter table public.job_assets validate constraint job_assets_job_principal_fkey;

revoke all on table public.job_outbox, public.job_assets from service_role;
grant select on table public.job_outbox, public.job_assets to service_role;

create or replace function public.claim_job_outbox(
  input_worker_id text,
  input_topics text[],
  input_lock_seconds integer default 60
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  claimed public.job_outbox%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  if input_worker_id is null or length(input_worker_id) not between 1 and 256
     or input_topics is null or cardinality(input_topics) not between 1 and 32
     or exists (
       select 1 from unnest(input_topics) as topic(value)
       where value is null or value !~ '^[a-z][a-z0-9_.-]{0,127}$'
     )
     or input_lock_seconds is null or input_lock_seconds not between 15 and 900 then
    raise exception 'invalid_job_outbox_claim' using errcode = '22023';
  end if;

  -- A process that dies on its final delivery attempt cannot acknowledge the
  -- row. Move that expired lease to the DLQ before looking for more work.
  update public.job_outbox
  set status = 'dead', locked_by = null, lock_expires_at = null,
      last_error = coalesce(last_error, 'outbox_delivery_lease_expired'),
      updated_at = v_now
  where status = 'publishing'
    and lock_expires_at <= v_now
    and attempts >= max_attempts;

  select * into claimed
  from public.job_outbox
  where topic = any(input_topics)
    and attempts < max_attempts
    and (
      (status in ('pending', 'failed') and available_at <= v_now)
      or (status = 'publishing' and lock_expires_at <= v_now)
    )
  order by available_at asc, created_at asc, id asc
  for update skip locked
  limit 1;

  if not found then
    return jsonb_build_object('acquired', false, 'reason', 'empty');
  end if;

  update public.job_outbox
  set status = 'publishing', attempts = attempts + 1,
      lock_version = lock_version + 1,
      locked_by = input_worker_id,
      lock_expires_at = v_now + make_interval(secs => input_lock_seconds),
      updated_at = v_now
  where id = claimed.id
  returning * into claimed;

  return jsonb_build_object(
    'acquired', true,
    'reason', 'claimed',
    'message', jsonb_build_object(
      'id', claimed.id,
      'jobId', claimed.job_id,
      'principalId', claimed.principal_id,
      'topic', claimed.topic,
      'payload', claimed.payload,
      'attempt', claimed.attempts,
      'maxAttempts', claimed.max_attempts,
      'lockVersion', claimed.lock_version,
      'lockExpiresAt', claimed.lock_expires_at,
      'createdAt', claimed.created_at
    )
  );
end;
$$;

revoke all on function public.claim_job_outbox(text,text[],integer)
  from public, anon, authenticated;
grant execute on function public.claim_job_outbox(text,text[],integer)
  to service_role;

create or replace function public.complete_job_outbox(
  input_outbox_id uuid,
  input_worker_id text,
  input_lock_version bigint,
  input_succeeded boolean,
  input_error text default null,
  input_retry_seconds integer default 30
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_message public.job_outbox%rowtype;
  next_status text;
  v_now timestamptz := clock_timestamp();
begin
  if input_outbox_id is null
     or input_worker_id is null or length(input_worker_id) not between 1 and 256
     or input_lock_version is null or input_lock_version < 1
     or input_succeeded is null
     or input_retry_seconds is null or input_retry_seconds not between 1 and 86400
     or octet_length(coalesce(input_error, '')) > 8192 then
    raise exception 'invalid_job_outbox_completion' using errcode = '22023';
  end if;

  select * into current_message from public.job_outbox
  where id = input_outbox_id for update;
  if not found then
    return jsonb_build_object('completed', false, 'reason', 'not_found');
  end if;

  -- Safe acknowledgement replay after a network timeout.
  if (input_succeeded and current_message.status = 'published')
     or (not input_succeeded and current_message.status in ('failed', 'dead')) then
    return jsonb_build_object(
      'completed', true, 'replayed', true,
      'reason', null, 'status', current_message.status
    );
  end if;

  if current_message.status <> 'publishing'
     or current_message.locked_by is distinct from input_worker_id
     or current_message.lock_version <> input_lock_version then
    return jsonb_build_object('completed', false, 'reason', 'stale_lock');
  end if;

  if input_succeeded then
    update public.job_outbox
    set status = 'published', published_at = v_now,
        locked_by = null, lock_expires_at = null, last_error = null,
        updated_at = v_now
    where id = current_message.id
    returning * into current_message;
  else
    next_status := case when current_message.attempts >= current_message.max_attempts
      then 'dead' else 'failed' end;
    update public.job_outbox
    set status = next_status,
        available_at = case when next_status = 'failed'
          then v_now + make_interval(secs => input_retry_seconds)
          else available_at end,
        locked_by = null, lock_expires_at = null,
        last_error = coalesce(nullif(input_error, ''), 'outbox_delivery_failed'),
        updated_at = v_now
    where id = current_message.id
    returning * into current_message;
  end if;

  return jsonb_build_object(
    'completed', true, 'replayed', false, 'reason', null,
    'status', current_message.status
  );
end;
$$;

revoke all on function public.complete_job_outbox(uuid,text,bigint,boolean,text,integer)
  from public, anon, authenticated;
grant execute on function public.complete_job_outbox(uuid,text,bigint,boolean,text,integer)
  to service_role;

create or replace function public.renew_job_outbox(
  input_outbox_id uuid,
  input_worker_id text,
  input_lock_version bigint,
  input_lock_seconds integer default 60
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  renewed public.job_outbox%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  if input_outbox_id is null
     or input_worker_id is null or length(input_worker_id) not between 1 and 256
     or input_lock_version is null or input_lock_version < 1
     or input_lock_seconds is null or input_lock_seconds not between 15 and 900 then
    raise exception 'invalid_job_outbox_renewal' using errcode = '22023';
  end if;
  update public.job_outbox
  set lock_expires_at = v_now + make_interval(secs => input_lock_seconds),
      updated_at = v_now
  where id = input_outbox_id and status = 'publishing'
    and locked_by = input_worker_id and lock_version = input_lock_version
  returning * into renewed;
  if not found then
    return jsonb_build_object('renewed', false, 'reason', 'stale_lock');
  end if;
  return jsonb_build_object(
    'renewed', true, 'reason', null,
    'lockExpiresAt', renewed.lock_expires_at
  );
end;
$$;

revoke all on function public.renew_job_outbox(uuid,text,bigint,integer)
  from public, anon, authenticated;
grant execute on function public.renew_job_outbox(uuid,text,bigint,integer)
  to service_role;

create or replace function public.prepare_job_asset_cleanup(
  input_outbox_id uuid,
  input_worker_id text,
  input_lock_version bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_message public.job_outbox%rowtype;
  object_keys jsonb;
  v_now timestamptz := clock_timestamp();
begin
  if input_outbox_id is null
     or input_worker_id is null or length(input_worker_id) not between 1 and 256
     or input_lock_version is null or input_lock_version < 1 then
    raise exception 'invalid_job_asset_cleanup' using errcode = '22023';
  end if;

  select * into current_message from public.job_outbox
  where id = input_outbox_id for update;
  if not found then
    return jsonb_build_object('prepared', false, 'reason', 'not_found');
  end if;
  if current_message.topic <> 'assets.cleanup'
     or current_message.status <> 'publishing'
     or current_message.locked_by is distinct from input_worker_id
     or current_message.lock_version <> input_lock_version then
    return jsonb_build_object('prepared', false, 'reason', 'stale_lock');
  end if;
  if not exists (
    select 1 from public.jobs
    where id = current_message.job_id
      and principal_id = current_message.principal_id
      and status in ('completed', 'failed', 'cancelled')
  ) then
    return jsonb_build_object('prepared', false, 'reason', 'job_not_terminal');
  end if;

  update public.job_assets
  set state = 'deleting', updated_at = v_now
  where job_id = current_message.job_id
    and principal_id = current_message.principal_id
    and state in ('reserved', 'uploaded');

  select coalesce(jsonb_agg(object_key order by object_key), '[]'::jsonb)
  into object_keys
  from public.job_assets
  where job_id = current_message.job_id
    and principal_id = current_message.principal_id
    and state = 'deleting';

  return jsonb_build_object(
    'prepared', true, 'reason', null, 'bucket', 'generated-media',
    'objectKeys', object_keys
  );
end;
$$;

revoke all on function public.prepare_job_asset_cleanup(uuid,text,bigint)
  from public, anon, authenticated;
grant execute on function public.prepare_job_asset_cleanup(uuid,text,bigint)
  to service_role;

create or replace function public.finish_job_asset_cleanup(
  input_outbox_id uuid,
  input_worker_id text,
  input_lock_version bigint,
  input_object_keys text[]
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_message public.job_outbox%rowtype;
  remaining_count bigint;
  v_now timestamptz := clock_timestamp();
begin
  if input_outbox_id is null
     or input_worker_id is null or length(input_worker_id) not between 1 and 256
     or input_lock_version is null or input_lock_version < 1
     or input_object_keys is null or cardinality(input_object_keys) > 256
     or exists (
       select 1 from unnest(input_object_keys) as object_key(value)
       where value is null or length(value) not between 1 and 1024
     ) then
    raise exception 'invalid_job_asset_cleanup_completion' using errcode = '22023';
  end if;

  select * into current_message from public.job_outbox
  where id = input_outbox_id for update;
  if not found then
    return jsonb_build_object('finished', false, 'reason', 'not_found');
  end if;
  if current_message.topic <> 'assets.cleanup'
     or current_message.status <> 'publishing'
     or current_message.locked_by is distinct from input_worker_id
     or current_message.lock_version <> input_lock_version then
    return jsonb_build_object('finished', false, 'reason', 'stale_lock');
  end if;

  update public.job_assets
  set state = 'deleted', deleted_at = v_now, updated_at = v_now
  where job_id = current_message.job_id
    and principal_id = current_message.principal_id
    and state = 'deleting'
    and object_key = any(input_object_keys);

  select count(*) into remaining_count from public.job_assets
  where job_id = current_message.job_id
    and principal_id = current_message.principal_id
    and state in ('reserved', 'uploaded', 'deleting');

  return jsonb_build_object(
    'finished', remaining_count = 0,
    'reason', case when remaining_count = 0 then null else 'assets_remaining' end,
    'remaining', remaining_count
  );
end;
$$;

revoke all on function public.finish_job_asset_cleanup(uuid,text,bigint,text[])
  from public, anon, authenticated;
grant execute on function public.finish_job_asset_cleanup(uuid,text,bigint,text[])
  to service_role;

-- Backfill cleanup intents for terminal jobs that predate this dispatcher.
insert into public.job_outbox(
  job_id, principal_id, topic, dedupe_key, payload, created_at, updated_at
)
select distinct
  job.id, job.principal_id, 'assets.cleanup', job.id::text || ':assets.cleanup',
  jsonb_build_object('jobId', job.id), clock_timestamp(), clock_timestamp()
from public.jobs as job
join public.job_assets as asset on asset.job_id = job.id
where job.status in ('completed', 'failed', 'cancelled')
  and asset.state in ('reserved', 'uploaded', 'deleting')
on conflict (job_id, dedupe_key) do nothing;

commit;
