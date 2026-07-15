-- Distributed SSE admission, bounded tenant resources, and durable payload
-- lifecycle. All mutable control paths remain service-role-only RPCs.
begin;

create table if not exists public.job_stream_leases (
  id uuid primary key,
  principal_id uuid not null,
  job_id uuid not null,
  address_hash text not null check (address_hash ~ '^[0-9a-f]{64}$'),
  acquired_at timestamptz not null default now(),
  expires_at timestamptz not null,
  hard_expires_at timestamptz not null,
  constraint job_stream_leases_job_principal_fkey
    foreign key (job_id, principal_id) references public.jobs(id, principal_id)
    on delete cascade,
  constraint job_stream_lease_time_check check (
    expires_at > acquired_at
    and hard_expires_at >= expires_at
    and hard_expires_at <= acquired_at + interval '15 minutes'
  )
);

create index if not exists job_stream_leases_expiry_idx
  on public.job_stream_leases(expires_at);
create index if not exists job_stream_leases_principal_expiry_idx
  on public.job_stream_leases(principal_id, expires_at);
create index if not exists job_stream_leases_address_expiry_idx
  on public.job_stream_leases(address_hash, expires_at);
create index if not exists job_stream_leases_job_expiry_idx
  on public.job_stream_leases(job_id, expires_at);

alter table public.job_stream_leases enable row level security;
revoke all on table public.job_stream_leases
  from public, anon, authenticated, service_role;

create or replace function public.acquire_job_event_stream(
  input_stream_id uuid,
  input_principal_id uuid,
  input_job_id uuid,
  input_address_hash text,
  input_lease_seconds integer default 45,
  input_max_seconds integer default 900
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  existing public.job_stream_leases%rowtype;
  principal_count integer;
  address_count integer;
  job_count integer;
  global_count integer;
  v_now timestamptz := clock_timestamp();
  v_hard_expires_at timestamptz;
  v_expires_at timestamptz;
begin
  if input_stream_id is null or input_principal_id is null or input_job_id is null
     or coalesce(input_address_hash, '') !~ '^[0-9a-f]{64}$'
     or input_lease_seconds is null or input_lease_seconds not between 15 and 60
     or input_max_seconds is null or input_max_seconds not between 60 and 900 then
    raise exception 'invalid_job_stream_admission' using
      errcode = '22023',
      detail = format(
        'stream_null=%s principal_null=%s job_null=%s hash_length=%s hash_valid=%s lease=%s max=%s',
        input_stream_id is null, input_principal_id is null, input_job_id is null,
        length(coalesce(input_address_hash, '')),
        coalesce(input_address_hash, '') ~ '^[0-9a-f]{64}$',
        input_lease_seconds, input_max_seconds
      );
  end if;

  -- One short global critical section makes all four distributed quotas exact,
  -- including simultaneous requests handled by different web instances.
  perform pg_advisory_xact_lock(5720260713260000);
  delete from public.job_stream_leases where expires_at <= v_now;

  select * into existing from public.job_stream_leases where id = input_stream_id;
  if found then
    if existing.principal_id <> input_principal_id
       or existing.job_id <> input_job_id
       or existing.address_hash <> input_address_hash then
      raise exception 'job_stream_idempotency_conflict' using errcode = '23505';
    end if;
    return jsonb_build_object(
      'acquired', true, 'reason', null, 'streamId', existing.id,
      'leaseExpiresAt', existing.expires_at,
      'hardExpiresAt', existing.hard_expires_at,
      'retryAfterSeconds', 0
    );
  end if;

  perform 1 from public.jobs
  where id = input_job_id and principal_id = input_principal_id;
  if not found then
    return jsonb_build_object(
      'acquired', false, 'reason', 'not_found', 'retryAfterSeconds', 5
    );
  end if;

  select count(*) into global_count from public.job_stream_leases;
  select count(*) into principal_count from public.job_stream_leases
    where principal_id = input_principal_id;
  select count(*) into address_count from public.job_stream_leases
    where address_hash = input_address_hash;
  select count(*) into job_count from public.job_stream_leases
    where job_id = input_job_id;
  if global_count >= 256 or principal_count >= 4 or address_count >= 12 or job_count >= 2 then
    return jsonb_build_object(
      'acquired', false, 'reason', 'capacity', 'retryAfterSeconds', 5
    );
  end if;

  v_hard_expires_at := v_now + make_interval(secs => input_max_seconds);
  v_expires_at := least(
    v_hard_expires_at,
    v_now + make_interval(secs => input_lease_seconds)
  );
  insert into public.job_stream_leases(
    id, principal_id, job_id, address_hash, acquired_at, expires_at, hard_expires_at
  ) values (
    input_stream_id, input_principal_id, input_job_id, input_address_hash,
    v_now, v_expires_at, v_hard_expires_at
  );
  return jsonb_build_object(
    'acquired', true, 'reason', null, 'streamId', input_stream_id,
    'leaseExpiresAt', v_expires_at, 'hardExpiresAt', v_hard_expires_at,
    'retryAfterSeconds', 0
  );
end;
$$;

create or replace function public.renew_job_event_stream(
  input_stream_id uuid,
  input_lease_seconds integer default 45
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_lease public.job_stream_leases%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  if input_stream_id is null
     or input_lease_seconds is null or input_lease_seconds not between 15 and 60 then
    raise exception 'invalid_job_stream_renewal' using errcode = '22023';
  end if;
  select * into current_lease from public.job_stream_leases
  where id = input_stream_id for update;
  if not found then
    return jsonb_build_object('renewed', false, 'reason', 'not_found');
  end if;
  if current_lease.expires_at <= v_now or current_lease.hard_expires_at <= v_now then
    delete from public.job_stream_leases where id = input_stream_id;
    return jsonb_build_object('renewed', false, 'reason', 'expired');
  end if;
  update public.job_stream_leases
  set expires_at = least(
    current_lease.hard_expires_at,
    v_now + make_interval(secs => input_lease_seconds)
  )
  where id = input_stream_id
  returning * into current_lease;
  return jsonb_build_object(
    'renewed', true, 'reason', null,
    'leaseExpiresAt', current_lease.expires_at,
    'hardExpiresAt', current_lease.hard_expires_at
  );
end;
$$;

create or replace function public.release_job_event_stream(input_stream_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  removed integer;
begin
  if input_stream_id is null then
    raise exception 'invalid_job_stream_release' using errcode = '22023';
  end if;
  delete from public.job_stream_leases where id = input_stream_id;
  get diagnostics removed = row_count;
  return jsonb_build_object('released', true, 'removed', removed);
end;
$$;

revoke all on function public.acquire_job_event_stream(uuid,uuid,uuid,text,integer,integer)
  from public, anon, authenticated, service_role;
revoke all on function public.renew_job_event_stream(uuid,integer)
  from public, anon, authenticated, service_role;
revoke all on function public.release_job_event_stream(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.acquire_job_event_stream(uuid,uuid,uuid,text,integer,integer)
  to service_role;
grant execute on function public.renew_job_event_stream(uuid,integer) to service_role;
grant execute on function public.release_job_event_stream(uuid) to service_role;

-- Payloads are registered as assets when the corresponding immutable Job is
-- inserted. Terminal Jobs retain them briefly, then a fenced outbox delivery
-- removes the Storage object before recording the tombstone.
create table if not exists public.job_payload_assets (
  job_id uuid primary key,
  principal_id uuid not null,
  bucket text not null default 'job-payloads' check (bucket = 'job-payloads'),
  object_key text not null unique check (length(object_key) between 1 and 512),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  bytes bigint not null check (bytes between 2 and 50331648),
  state text not null default 'active'
    check (state in ('active', 'retained', 'deleting', 'deleted')),
  retain_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint job_payload_assets_job_principal_fkey
    foreign key (job_id, principal_id) references public.jobs(id, principal_id)
    on delete restrict,
  constraint job_payload_assets_state_timestamps_check check (
    (state = 'active' and retain_until is null and deleted_at is null)
    or (state in ('retained', 'deleting') and retain_until is not null and deleted_at is null)
    or (state = 'deleted' and retain_until is not null and deleted_at is not null)
  )
);

create index if not exists job_payload_assets_cleanup_idx
  on public.job_payload_assets(retain_until, state)
  where state in ('retained', 'deleting');
create index if not exists job_payload_assets_principal_state_idx
  on public.job_payload_assets(principal_id, state);
alter table public.job_payload_assets enable row level security;
revoke all on table public.job_payload_assets
  from public, anon, authenticated, service_role;
grant select on table public.job_payload_assets to service_role;

create table if not exists public.tenant_resource_usage (
  principal_id uuid primary key,
  project_file_count bigint not null default 0 check (project_file_count >= 0),
  project_file_bytes bigint not null default 0 check (project_file_bytes >= 0),
  message_count bigint not null default 0 check (message_count >= 0),
  message_bytes bigint not null default 0 check (message_bytes >= 0),
  payload_count bigint not null default 0 check (payload_count >= 0),
  payload_bytes bigint not null default 0 check (payload_bytes >= 0),
  updated_at timestamptz not null default now()
);
alter table public.tenant_resource_usage enable row level security;
revoke all on table public.tenant_resource_usage
  from public, anon, authenticated, service_role;
grant select on table public.tenant_resource_usage to service_role;

create or replace function public.adjust_tenant_resource_usage(
  input_principal_id uuid,
  input_project_file_count bigint default 0,
  input_project_file_bytes bigint default 0,
  input_message_count bigint default 0,
  input_message_bytes bigint default 0,
  input_payload_count bigint default 0,
  input_payload_bytes bigint default 0
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  accepted uuid;
begin
  if input_principal_id is null then
    raise exception 'invalid_tenant_resource_principal' using errcode = '22023';
  end if;
  insert into public.tenant_resource_usage(principal_id, updated_at)
  values (input_principal_id, clock_timestamp())
  on conflict (principal_id) do nothing;
  update public.tenant_resource_usage set
    project_file_count = project_file_count + input_project_file_count,
    project_file_bytes = project_file_bytes + input_project_file_bytes,
    message_count = message_count + input_message_count,
    message_bytes = message_bytes + input_message_bytes,
    payload_count = payload_count + input_payload_count,
    payload_bytes = payload_bytes + input_payload_bytes,
    updated_at = clock_timestamp()
  where principal_id = input_principal_id
    and project_file_count + input_project_file_count >= 0
    and (project_file_count + input_project_file_count <= 200
      or input_project_file_count <= 0)
    and project_file_bytes + input_project_file_bytes >= 0
    and (project_file_bytes + input_project_file_bytes <= 67108864
      or input_project_file_bytes <= 0)
    and message_count + input_message_count >= 0
    and (message_count + input_message_count <= 100000
      or input_message_count <= 0)
    and message_bytes + input_message_bytes >= 0
    and (message_bytes + input_message_bytes <= 1073741824
      or input_message_bytes <= 0)
    and payload_count + input_payload_count >= 0
    and (payload_count + input_payload_count <= 128
      or input_payload_count <= 0)
    and payload_bytes + input_payload_bytes >= 0
    and (payload_bytes + input_payload_bytes <= 536870912
      or input_payload_bytes <= 0)
  returning principal_id into accepted;
  if accepted is null then
    raise exception 'tenant_resource_quota_exceeded' using errcode = '54000';
  end if;
end;
$$;

create or replace function public.track_project_file_resource_usage()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  old_bytes bigint := case when tg_op = 'INSERT' then 0 else octet_length(coalesce(old.content, '')) end;
  new_bytes bigint := case when tg_op = 'DELETE' then 0 else octet_length(coalesce(new.content, '')) end;
begin
  if tg_op <> 'DELETE' and (new_bytes > 1048576 or octet_length(coalesce(new.name, '')) > 512) then
    raise exception 'project_file_too_large' using errcode = '54000';
  end if;
  if tg_op = 'INSERT' then
    perform public.adjust_tenant_resource_usage(new.user_id, 1, new_bytes);
    return new;
  elsif tg_op = 'DELETE' then
    perform public.adjust_tenant_resource_usage(old.user_id, -1, -old_bytes);
    return old;
  elsif old.user_id = new.user_id then
    perform public.adjust_tenant_resource_usage(new.user_id, 0, new_bytes - old_bytes);
  else
    perform public.adjust_tenant_resource_usage(old.user_id, -1, -old_bytes);
    perform public.adjust_tenant_resource_usage(new.user_id, 1, new_bytes);
  end if;
  return new;
end;
$$;

create or replace function public.track_message_resource_usage()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  old_bytes bigint := case when tg_op = 'INSERT' then 0 else
    octet_length(coalesce(old.content, '')) + octet_length(coalesce(old.thinking, ''))
    + octet_length(coalesce(old.content_parts, '[]'::jsonb)::text)
    + octet_length(coalesce(old.thinking_parts, '[]'::jsonb)::text)
    + octet_length(coalesce(old.images, 'null'::jsonb)::text) end;
  new_bytes bigint := case when tg_op = 'DELETE' then 0 else
    octet_length(coalesce(new.content, '')) + octet_length(coalesce(new.thinking, ''))
    + octet_length(coalesce(new.content_parts, '[]'::jsonb)::text)
    + octet_length(coalesce(new.thinking_parts, '[]'::jsonb)::text)
    + octet_length(coalesce(new.images, 'null'::jsonb)::text) end;
begin
  if tg_op <> 'DELETE' and new_bytes > 2097152 then
    raise exception 'message_too_large' using errcode = '54000';
  end if;
  if tg_op = 'INSERT' then
    perform public.adjust_tenant_resource_usage(new.user_id, 0, 0, 1, new_bytes);
    return new;
  elsif tg_op = 'DELETE' then
    perform public.adjust_tenant_resource_usage(old.user_id, 0, 0, -1, -old_bytes);
    return old;
  elsif old.user_id = new.user_id then
    perform public.adjust_tenant_resource_usage(new.user_id, 0, 0, 0, new_bytes - old_bytes);
  else
    perform public.adjust_tenant_resource_usage(old.user_id, 0, 0, -1, -old_bytes);
    perform public.adjust_tenant_resource_usage(new.user_id, 0, 0, 1, new_bytes);
  end if;
  return new;
end;
$$;

create or replace function public.track_job_payload_resource_usage()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  old_active boolean := tg_op <> 'INSERT' and old.state <> 'deleted';
  new_active boolean := tg_op <> 'DELETE' and new.state <> 'deleted';
begin
  if tg_op = 'INSERT' then
    perform public.adjust_tenant_resource_usage(new.principal_id, 0, 0, 0, 0, 1, new.bytes);
    return new;
  elsif tg_op = 'DELETE' then
    if old_active then
      perform public.adjust_tenant_resource_usage(old.principal_id, 0, 0, 0, 0, -1, -old.bytes);
    end if;
    return old;
  elsif old.principal_id <> new.principal_id or old.bytes <> new.bytes then
    raise exception 'job_payload_asset_identity_immutable' using errcode = '55000';
  elsif old_active and not new_active then
    perform public.adjust_tenant_resource_usage(old.principal_id, 0, 0, 0, 0, -1, -old.bytes);
  elsif not old_active and new_active then
    perform public.adjust_tenant_resource_usage(new.principal_id, 0, 0, 0, 0, 1, new.bytes);
  end if;
  return new;
end;
$$;

drop trigger if exists track_project_file_resource_usage on public.project_files;
create trigger track_project_file_resource_usage
before insert or update or delete on public.project_files
for each row execute function public.track_project_file_resource_usage();
drop trigger if exists track_message_resource_usage on public.messages;
create trigger track_message_resource_usage
before insert or update or delete on public.messages
for each row execute function public.track_message_resource_usage();
-- This new internal table is not writable by old application instances. Keep
-- its counter trigger disabled during the legacy import so an already
-- over-limit tenant can be represented, then install it before cutover.
drop trigger if exists track_job_payload_resource_usage on public.job_payload_assets;

revoke all on function public.adjust_tenant_resource_usage(uuid,bigint,bigint,bigint,bigint,bigint,bigint)
  from public, anon, authenticated, service_role;
revoke all on function public.track_project_file_resource_usage()
  from public, anon, authenticated, service_role;
revoke all on function public.track_message_resource_usage()
  from public, anon, authenticated, service_role;
revoke all on function public.track_job_payload_resource_usage()
  from public, anon, authenticated, service_role;

create or replace function public.register_job_payload_asset()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  object_key text;
  payload_sha256 text;
  payload_bytes bigint;
begin
  if not new.payload ? 'payloadRef' then return new; end if;
  if jsonb_typeof(new.payload->'payloadRef') = 'object' then
    object_key := new.payload->'payloadRef'->>'objectKey';
    payload_sha256 := new.payload->'payloadRef'->>'sha256';
    if coalesce(new.payload->'payloadRef'->>'bytes', '') ~ '^[0-9]+$' then
      payload_bytes := (new.payload->'payloadRef'->>'bytes')::bigint;
    end if;
  else
    object_key := new.payload->>'payloadRef';
    payload_sha256 := new.payload->>'payloadHash';
    if coalesce(new.payload->>'payloadBytes', '') ~ '^[0-9]+$' then
      payload_bytes := (new.payload->>'payloadBytes')::bigint;
    end if;
  end if;
  if object_key <> new.principal_id::text || '/' || new.id::text || '/' || payload_sha256 || '.json'
     or coalesce(payload_sha256, '') !~ '^[0-9a-f]{64}$'
     or payload_bytes is null or payload_bytes not between 2 and 8388608 then
    raise exception 'invalid_bounded_job_payload' using errcode = '22023';
  end if;
  insert into public.job_payload_assets(
    job_id, principal_id, object_key, sha256, bytes, state,
    created_at, updated_at
  ) values (
    new.id, new.principal_id, object_key, payload_sha256, payload_bytes, 'active',
    clock_timestamp(), clock_timestamp()
  );
  return new;
end;
$$;

create or replace function public.retain_job_payload_on_terminal()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  retention interval;
  cleanup_at timestamptz;
begin
  if new.status not in ('completed', 'failed', 'cancelled')
     or old.status in ('completed', 'failed', 'cancelled') then
    return new;
  end if;
  retention := case when new.status = 'completed' then interval '15 minutes' else interval '1 hour' end;
  cleanup_at := clock_timestamp() + retention;
  update public.job_payload_assets
  set state = 'retained', retain_until = cleanup_at, updated_at = clock_timestamp()
  where job_id = new.id and principal_id = new.principal_id and state = 'active';
  if found then
    insert into public.job_outbox(
      job_id, principal_id, topic, dedupe_key, payload, status,
      available_at, created_at, updated_at
    ) values (
      new.id, new.principal_id, 'payloads.cleanup', new.id::text || ':payloads.cleanup',
      jsonb_build_object('jobId', new.id, 'bucket', 'job-payloads'), 'pending',
      cleanup_at, clock_timestamp(), clock_timestamp()
    ) on conflict (job_id, dedupe_key) do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists register_job_payload_asset on public.jobs;
create trigger register_job_payload_asset
after insert on public.jobs
for each row execute function public.register_job_payload_asset();
drop trigger if exists retain_job_payload_on_terminal on public.jobs;
create trigger retain_job_payload_on_terminal
after update of status on public.jobs
for each row execute function public.retain_job_payload_on_terminal();

revoke all on function public.register_job_payload_asset()
  from public, anon, authenticated, service_role;
revoke all on function public.retain_job_payload_on_terminal()
  from public, anon, authenticated, service_role;

-- All old-application write boundaries are locked by their newly installed
-- triggers before either scan begins. An in-flight writer commits before the
-- trigger DDL obtains its lock and is visible to these READ COMMITTED scans;
-- later writers resume only after commit and execute the new triggers.
--
-- Existing payload references are admitted under the legacy 48 MiB envelope;
-- all new uploads are limited to 8 MiB by register_job_payload_asset().
insert into public.job_payload_assets(
  job_id, principal_id, object_key, sha256, bytes, state, retain_until,
  created_at, updated_at
)
select
  job.id,
  job.principal_id,
  case when jsonb_typeof(job.payload->'payloadRef') = 'object'
    then job.payload->'payloadRef'->>'objectKey'
    else job.payload->>'payloadRef' end,
  case when jsonb_typeof(job.payload->'payloadRef') = 'object'
    then job.payload->'payloadRef'->>'sha256'
    else job.payload->>'payloadHash' end,
  coalesce(
    case when jsonb_typeof(job.payload->'payloadRef') = 'object'
      and coalesce(job.payload->'payloadRef'->>'bytes', '') ~ '^[0-9]+$'
      then (job.payload->'payloadRef'->>'bytes')::bigint end,
    case when coalesce(job.payload->>'payloadBytes', '') ~ '^[0-9]+$'
      then (job.payload->>'payloadBytes')::bigint end,
    case when coalesce(object.metadata->>'size', '') ~ '^[0-9]+$'
      then (object.metadata->>'size')::bigint end
  ),
  case when job.status in ('completed', 'failed', 'cancelled') then 'retained' else 'active' end,
  case when job.status = 'completed' then coalesce(job.terminal_at, job.updated_at) + interval '15 minutes'
    when job.status in ('failed', 'cancelled') then coalesce(job.terminal_at, job.updated_at) + interval '1 hour'
    else null end,
  job.created_at,
  clock_timestamp()
from public.jobs as job
join storage.objects as object
  on object.bucket_id = 'job-payloads'
 and object.name = case when jsonb_typeof(job.payload->'payloadRef') = 'object'
   then job.payload->'payloadRef'->>'objectKey' else job.payload->>'payloadRef' end
where job.payload ? 'payloadRef'
  and coalesce(case when jsonb_typeof(job.payload->'payloadRef') = 'object'
    then job.payload->'payloadRef'->>'sha256' else job.payload->>'payloadHash' end, '')
      ~ '^[0-9a-f]{64}$'
  and coalesce(
    case when jsonb_typeof(job.payload->'payloadRef') = 'object'
      and coalesce(job.payload->'payloadRef'->>'bytes', '') ~ '^[0-9]+$'
      then (job.payload->'payloadRef'->>'bytes')::bigint end,
    case when coalesce(job.payload->>'payloadBytes', '') ~ '^[0-9]+$'
      then (job.payload->>'payloadBytes')::bigint end,
    case when coalesce(object.metadata->>'size', '') ~ '^[0-9]+$'
      then (object.metadata->>'size')::bigint end
  ) between 2 and 50331648
on conflict (job_id) do nothing;

create trigger track_job_payload_resource_usage
before insert or update or delete on public.job_payload_assets
for each row execute function public.track_job_payload_resource_usage();

-- Reconcile from source tables after the idempotent asset import. Including
-- existing counter rows resets principals whose last resource disappeared and
-- makes rerunning this migration repair an interrupted earlier rollout.
with source_principals as (
  select principal_id from public.tenant_resource_usage
  union
  select user_id from public.project_files
  union
  select user_id from public.messages
  union
  select principal_id from public.job_payload_assets
), authoritative_usage as (
  select principal_id,
    (select count(*) from public.project_files
       where user_id = source_principals.principal_id) as project_file_count,
    (select coalesce(sum(octet_length(coalesce(content, ''))), 0)
       from public.project_files
       where user_id = source_principals.principal_id) as project_file_bytes,
    (select count(*) from public.messages
       where user_id = source_principals.principal_id) as message_count,
    (select coalesce(sum(
       octet_length(coalesce(content, '')) + octet_length(coalesce(thinking, ''))
       + octet_length(coalesce(content_parts, '[]'::jsonb)::text)
       + octet_length(coalesce(thinking_parts, '[]'::jsonb)::text)
       + octet_length(coalesce(images, 'null'::jsonb)::text)
     ), 0) from public.messages
       where user_id = source_principals.principal_id) as message_bytes,
    (select count(*) from public.job_payload_assets
       where principal_id = source_principals.principal_id and state <> 'deleted') as payload_count,
    (select coalesce(sum(bytes), 0) from public.job_payload_assets
       where principal_id = source_principals.principal_id and state <> 'deleted') as payload_bytes
  from source_principals
)
insert into public.tenant_resource_usage(
  principal_id, project_file_count, project_file_bytes,
  message_count, message_bytes, payload_count, payload_bytes, updated_at
)
select
  principal_id, project_file_count, project_file_bytes,
  message_count, message_bytes, payload_count, payload_bytes, clock_timestamp()
from authoritative_usage
on conflict (principal_id) do update set
  project_file_count = excluded.project_file_count,
  project_file_bytes = excluded.project_file_bytes,
  message_count = excluded.message_count,
  message_bytes = excluded.message_bytes,
  payload_count = excluded.payload_count,
  payload_bytes = excluded.payload_bytes,
  updated_at = excluded.updated_at;

insert into public.job_outbox(
  job_id, principal_id, topic, dedupe_key, payload, status,
  available_at, created_at, updated_at
)
select
  asset.job_id, asset.principal_id, 'payloads.cleanup',
  asset.job_id::text || ':payloads.cleanup',
  jsonb_build_object('jobId', asset.job_id, 'bucket', 'job-payloads'),
  'pending', asset.retain_until, clock_timestamp(), clock_timestamp()
from public.job_payload_assets as asset
where asset.state in ('retained', 'deleting') and asset.retain_until is not null
on conflict (job_id, dedupe_key) do nothing;

create or replace function public.prepare_job_payload_cleanup(
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
  current_asset public.job_payload_assets%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  if input_outbox_id is null
     or input_worker_id is null or length(input_worker_id) not between 1 and 256
     or input_lock_version is null or input_lock_version < 1 then
    raise exception 'invalid_job_payload_cleanup' using errcode = '22023';
  end if;
  select * into current_message from public.job_outbox
  where id = input_outbox_id for update;
  if not found then
    return jsonb_build_object('prepared', false, 'reason', 'not_found');
  end if;
  if current_message.topic <> 'payloads.cleanup'
     or current_message.status <> 'publishing'
     or current_message.locked_by is distinct from input_worker_id
     or current_message.lock_version <> input_lock_version
     or current_message.lock_expires_at <= v_now then
    return jsonb_build_object('prepared', false, 'reason', 'stale_lock');
  end if;
  select * into current_asset from public.job_payload_assets
  where job_id = current_message.job_id and principal_id = current_message.principal_id
  for update;
  if not found or current_asset.state = 'deleted' then
    return jsonb_build_object('prepared', true, 'reason', null, 'objectKey', null);
  end if;
  if current_asset.state not in ('retained', 'deleting')
     or current_asset.retain_until is null or current_asset.retain_until > v_now then
    return jsonb_build_object('prepared', false, 'reason', 'retention_active');
  end if;
  update public.job_payload_assets
  set state = 'deleting', updated_at = v_now
  where job_id = current_asset.job_id;
  return jsonb_build_object(
    'prepared', true, 'reason', null, 'objectKey', current_asset.object_key
  );
end;
$$;

create or replace function public.finish_job_payload_cleanup(
  input_outbox_id uuid,
  input_worker_id text,
  input_lock_version bigint,
  input_object_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_message public.job_outbox%rowtype;
  current_asset public.job_payload_assets%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  if input_outbox_id is null
     or input_worker_id is null or length(input_worker_id) not between 1 and 256
     or input_lock_version is null or input_lock_version < 1
     or (input_object_key is not null and length(input_object_key) not between 1 and 512) then
    raise exception 'invalid_job_payload_cleanup_completion' using errcode = '22023';
  end if;
  select * into current_message from public.job_outbox
  where id = input_outbox_id for update;
  if not found then
    return jsonb_build_object('finished', false, 'reason', 'not_found');
  end if;
  if current_message.topic <> 'payloads.cleanup'
     or current_message.status <> 'publishing'
     or current_message.locked_by is distinct from input_worker_id
     or current_message.lock_version <> input_lock_version
     or current_message.lock_expires_at <= v_now then
    return jsonb_build_object('finished', false, 'reason', 'stale_lock');
  end if;
  select * into current_asset from public.job_payload_assets
  where job_id = current_message.job_id and principal_id = current_message.principal_id
  for update;
  if not found or current_asset.state = 'deleted' then
    return jsonb_build_object('finished', true, 'reason', null);
  end if;
  if current_asset.state <> 'deleting'
     or input_object_key is distinct from current_asset.object_key then
    return jsonb_build_object('finished', false, 'reason', 'asset_mismatch');
  end if;
  update public.job_payload_assets
  set state = 'deleted', deleted_at = v_now, updated_at = v_now
  where job_id = current_asset.job_id;
  return jsonb_build_object('finished', true, 'reason', null);
end;
$$;

revoke all on function public.prepare_job_payload_cleanup(uuid,text,bigint)
  from public, anon, authenticated, service_role;
revoke all on function public.finish_job_payload_cleanup(uuid,text,bigint,text)
  from public, anon, authenticated, service_role;
grant execute on function public.prepare_job_payload_cleanup(uuid,text,bigint)
  to service_role;
grant execute on function public.finish_job_payload_cleanup(uuid,text,bigint,text)
  to service_role;

-- Storage rejects new oversized objects before application memory or workers
-- can turn them into durable queue pressure.
update storage.buckets
set public = false,
    file_size_limit = 8388608,
    allowed_mime_types = array['application/json']::text[]
where id = 'job-payloads';

-- v6-v8 intentionally chain through v5. Evolve that compatibility contract so
-- old application instances remain healthy during the rolling migration from
-- the legacy 48 MiB bucket envelope to the bounded 8 MiB envelope.
create or replace function public.runtime_healthcheck_v5()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    to_regclass('public.api_rate_limits') is not null
    and to_regclass('public.chat_generations') is not null
    and to_regclass('public.generated_media_cleanup_jobs') is not null
    and to_regclass('public.jobs') is not null
    and to_regclass('public.job_events') is not null
    and to_regclass('public.job_checkpoints') is not null
    and to_regclass('public.job_tool_effects') is not null
    and to_regclass('public.job_outbox') is not null
    and to_regclass('public.job_assets') is not null
    and to_regclass('public.ledger_entries') is not null
    and to_regclass('public.audit_log') is not null
    and to_regclass('public.github_connections') is not null
    and to_regprocedure('public.consume_api_rate_limit(text,integer,integer)') is not null
    and to_regprocedure(
      'public.enqueue_job(uuid,text,text,uuid,text,jsonb,text,text,jsonb,jsonb,integer,integer,timestamptz)'
    ) is not null
    and to_regprocedure('public.claim_next_job(text,text[],integer)') is not null
    and to_regprocedure('public.renew_job_lease(uuid,text,bigint,integer)') is not null
    and to_regprocedure('public.retry_job(uuid,text,bigint,text,text,integer)') is not null
    and to_regprocedure('public.append_job_events(uuid,text,bigint,jsonb)') is not null
    and to_regprocedure(
      'public.checkpoint_job(uuid,text,bigint,text,jsonb,jsonb,boolean,text)'
    ) is not null
    and to_regprocedure(
      'public.record_job_tool_effect(uuid,text,bigint,text,text,text,text,text,jsonb,boolean,jsonb)'
    ) is not null
    and to_regprocedure(
      'public.finalize_job(uuid,text,bigint,text,jsonb,text,text,jsonb,jsonb)'
    ) is not null
    and to_regprocedure('public.cancel_job(uuid,uuid,text)') is not null
    and to_regprocedure(
      'public.record_job_asset(uuid,text,bigint,uuid,text,text,text,text,bigint,text)'
    ) is not null
    and to_regprocedure('public.claim_job_outbox(text,text[],integer)') is not null
    and to_regprocedure('public.renew_job_outbox(uuid,text,bigint,integer)') is not null
    and to_regprocedure(
      'public.complete_job_outbox(uuid,text,bigint,boolean,text,integer)'
    ) is not null
    and to_regprocedure('public.prepare_job_asset_cleanup(uuid,text,bigint)') is not null
    and to_regprocedure('public.finish_job_asset_cleanup(uuid,text,bigint,text[])') is not null
    and has_function_privilege(
      'service_role', 'public.claim_next_job(text,text[],integer)', 'EXECUTE'
    )
    and has_function_privilege(
      'service_role', 'public.finalize_job(uuid,text,bigint,text,jsonb,text,text,jsonb,jsonb)',
      'EXECUTE'
    )
    and has_function_privilege(
      'service_role', 'public.record_job_asset(uuid,text,bigint,uuid,text,text,text,text,bigint,text)',
      'EXECUTE'
    )
    and has_function_privilege(
      'service_role', 'public.claim_job_outbox(text,text[],integer)', 'EXECUTE'
    )
    and has_function_privilege(
      'service_role', 'public.renew_job_outbox(uuid,text,bigint,integer)', 'EXECUTE'
    )
    and has_function_privilege(
      'service_role',
      'public.complete_job_outbox(uuid,text,bigint,boolean,text,integer)', 'EXECUTE'
    )
    and has_function_privilege(
      'service_role', 'public.prepare_job_asset_cleanup(uuid,text,bigint)', 'EXECUTE'
    )
    and has_function_privilege(
      'service_role', 'public.finish_job_asset_cleanup(uuid,text,bigint,text[])', 'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated', 'public.claim_next_job(text,text[],integer)', 'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated', 'public.finalize_job(uuid,text,bigint,text,jsonb,text,text,jsonb,jsonb)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated', 'public.claim_job_outbox(text,text[],integer)', 'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated', 'public.prepare_job_asset_cleanup(uuid,text,bigint)', 'EXECUTE'
    )
    and not has_table_privilege('authenticated', 'public.jobs', 'UPDATE')
    and not has_table_privilege('authenticated', 'public.job_outbox', 'UPDATE')
    and not has_table_privilege('service_role', 'public.job_outbox', 'UPDATE')
    and not has_table_privilege('service_role', 'public.job_assets', 'UPDATE')
    and exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'job_outbox'
        and column_name in ('lock_version', 'max_attempts')
      group by table_schema, table_name having count(*) = 2
    )
    and exists (
      select 1 from pg_catalog.pg_class
      where oid = 'public.jobs'::regclass and relrowsecurity
    )
    and exists (
      select 1 from pg_catalog.pg_class
      where oid = 'public.job_assets'::regclass and relrowsecurity
    )
    and exists (
      select 1 from pg_catalog.pg_trigger
      where tgrelid = 'public.jobs'::regclass
        and tgname = 'enforce_job_state_contract'
        and not tgisinternal and tgenabled <> 'D'
    )
    and exists (
      select 1 from pg_catalog.pg_trigger
      where tgrelid = 'public.generated_media_cleanup_jobs'::regclass
        and tgname = 'reconcile_history_job_asset_cleanup'
        and not tgisinternal and tgenabled <> 'D'
    )
    and exists (
      select 1 from pg_catalog.pg_trigger
      where tgrelid = 'public.messages'::regclass
        and tgname = 'enforce_message_sor_contract'
        and not tgisinternal and tgenabled <> 'D'
    )
    and exists (
      select 1 from storage.buckets
      where id = 'generated-media' and public = false
        and coalesce(file_size_limit, 0) = 10485760
    )
    and not exists (
      select 1 from pg_catalog.pg_policies
      where schemaname = 'storage' and tablename = 'objects'
        and policyname in (
          'generated_media_public_read', 'generated_media_upload_own',
          'generated_media_update_own', 'generated_media_delete_own'
        )
    )
    and exists (
      select 1 from storage.buckets
      where id = 'job-payloads' and public = false and file_size_limit = 8388608
    );
$$;

revoke all on function public.runtime_healthcheck_v5()
  from public, anon, authenticated;
grant execute on function public.runtime_healthcheck_v5() to service_role;

create or replace function public.sweep_job_lifecycle(
  input_batch_size integer default 500,
  input_published_before timestamptz default clock_timestamp() - interval '7 days'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  outbox_deleted integer;
  stream_leases_deleted integer;
  expired_reservations_reclaimed integer := 0;
  candidate record;
  held_reservation public.job_admission_reservations%rowtype;
  current_job public.jobs%rowtype;
  settlement jsonb;
  v_now timestamptz := clock_timestamp();
begin
  if input_batch_size is null or input_batch_size not between 1 and 2000
     or input_published_before is null
     or input_published_before > clock_timestamp() - interval '1 hour' then
    raise exception 'invalid_job_lifecycle_sweep' using errcode = '22023';
  end if;
  with expired as (
    select id from public.job_stream_leases
    where expires_at <= clock_timestamp()
    order by expires_at, id
    limit input_batch_size
    for update skip locked
  )
  delete from public.job_stream_leases lease using expired
  where lease.id = expired.id;
  get diagnostics stream_leases_deleted = row_count;

  -- Jobs are locked before reservations, matching finalize/settle lock order.
  -- A fresh execution lease always wins over an expired financial hold; the
  -- next sweep re-evaluates it after the Worker finishes or loses its lease.
  for candidate in
    select job.id
    from public.jobs as job
    join public.job_admission_reservations as reservation
      on reservation.job_id = job.id
    where reservation.status = 'held' and reservation.expires_at <= v_now
      and (
        job.status in ('completed', 'failed', 'cancelled')
        or job.lease_expires_at is null
        or job.lease_expires_at <= v_now
      )
    order by reservation.expires_at, job.id
    limit input_batch_size
    for update of job skip locked
  loop
    select * into held_reservation
    from public.job_admission_reservations
    where job_id = candidate.id for update;
    if not found or held_reservation.status <> 'held'
       or held_reservation.expires_at > v_now then
      continue;
    end if;
    select * into strict current_job from public.jobs where id = candidate.id;
    if current_job.status in ('completed', 'failed', 'cancelled') then
      settlement := public.settle_job_admission(current_job.id, 'reservation.expired');
      if settlement->>'settled' = 'true' then
        expired_reservations_reclaimed := expired_reservations_reclaimed + 1;
      end if;
      continue;
    end if;
    if current_job.lease_expires_at is not null and current_job.lease_expires_at > v_now then
      continue;
    end if;

    update public.jobs
    set status = 'failed',
        result = coalesce(result, '{}'::jsonb),
        error_class = 'policy',
        error_code = 'JOB_ADMISSION_EXPIRED',
        event_sequence = event_sequence + 1,
        lease_owner = null,
        lease_expires_at = null,
        terminal_at = v_now,
        updated_at = v_now
    where id = current_job.id
      and status not in ('completed', 'failed', 'cancelled')
      and (lease_expires_at is null or lease_expires_at <= v_now)
    returning * into current_job;
    if not found then continue; end if;

    insert into public.job_events(
      job_id, principal_id, seq, kind, idempotency_key, payload, created_at
    ) values (
      current_job.id, current_job.principal_id, current_job.event_sequence,
      'job.terminal', 'reservation.expired',
      jsonb_build_object(
        'status', 'failed', 'result', current_job.result,
        'errorClass', 'policy', 'errorCode', 'JOB_ADMISSION_EXPIRED',
        'retryable', false
      ), v_now
    );
    insert into public.job_outbox(
      job_id, principal_id, topic, dedupe_key, payload, created_at, updated_at
    ) values (
      current_job.id, current_job.principal_id, 'jobs.terminal',
      current_job.id::text || ':terminal',
      jsonb_build_object(
        'jobId', current_job.id, 'type', current_job.type,
        'status', 'failed', 'errorCode', 'JOB_ADMISSION_EXPIRED',
        'eventSeq', current_job.event_sequence
      ), v_now, v_now
    ) on conflict (job_id, dedupe_key) do nothing;
    insert into public.audit_log(
      principal_id, actor_type, actor_id, action, resource_type, resource_id,
      job_id, metadata, created_at
    ) values (
      current_job.principal_id, 'system', 'lifecycle-sweeper',
      'job.admission_expired', 'job', current_job.id::text, current_job.id,
      jsonb_build_object('eventSeq', current_job.event_sequence), v_now
    );
    expired_reservations_reclaimed := expired_reservations_reclaimed + 1;
  end loop;

  with published as (
    select id from public.job_outbox
    where status = 'published' and published_at < input_published_before
    order by published_at, id
    limit input_batch_size
    for update skip locked
  )
  delete from public.job_outbox outbox using published
  where outbox.id = published.id;
  get diagnostics outbox_deleted = row_count;

  return jsonb_build_object(
    'outboxDeleted', outbox_deleted,
    'streamLeasesDeleted', stream_leases_deleted,
    'expiredReservationsReclaimed', expired_reservations_reclaimed
  );
end;
$$;

revoke all on function public.sweep_job_lifecycle(integer,timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.sweep_job_lifecycle(integer,timestamptz)
  to service_role;

create or replace function public.read_stream_lifecycle_metrics_v1()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'schemaVersion', 1,
    'generatedAt', statement_timestamp(),
    'activeStreams', (
      select count(*) from public.job_stream_leases
      where expires_at > statement_timestamp()
    ),
    'streamCapacity', 256,
    'expiredStreamLeases', (
      select count(*) from public.job_stream_leases
      where expires_at <= statement_timestamp()
    ),
    'expiredAdmissionReservations', (
      select count(*) from public.job_admission_reservations
      where status = 'held' and expires_at <= statement_timestamp()
    ),
    'retainedPayloads', (
      select count(*) from public.job_payload_assets
      where state in ('retained', 'deleting')
    ),
    'overduePayloads', (
      select count(*) from public.job_payload_assets
      where state in ('retained', 'deleting')
        and retain_until < statement_timestamp() - interval '5 minutes'
    ),
    'payloadCleanupDeadLetters', (
      select count(*) from public.job_outbox
      where topic = 'payloads.cleanup' and status = 'dead'
    ),
    'outboxGcEligible', (
      select count(*) from public.job_outbox
      where status = 'published'
        and published_at < statement_timestamp() - interval '7 days'
    ),
    'tenantsNearResourceLimit', (
      select count(*) from public.tenant_resource_usage
      where project_file_count >= 180 or project_file_bytes >= 60397977
        or message_count >= 90000 or message_bytes >= 966367642
        or payload_count >= 115 or payload_bytes >= 483183821
    )
  );
$$;

revoke all on function public.read_stream_lifecycle_metrics_v1()
  from public, anon, authenticated, service_role;
grant execute on function public.read_stream_lifecycle_metrics_v1() to service_role;

create or replace function public.runtime_healthcheck_v11()
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  upstream_ready boolean := false;
begin
  if to_regprocedure('public.runtime_healthcheck_v10()') is not null then
    execute 'select public.runtime_healthcheck_v10()' into upstream_ready;
  elsif to_regprocedure('public.runtime_healthcheck_v9()') is not null then
    execute 'select public.runtime_healthcheck_v9()' into upstream_ready;
  else
    upstream_ready := public.runtime_healthcheck_v8();
  end if;
  return upstream_ready
    and to_regclass('public.job_stream_leases') is not null
    and to_regclass('public.job_payload_assets') is not null
    and to_regclass('public.tenant_resource_usage') is not null
    and to_regprocedure('public.acquire_job_event_stream(uuid,uuid,uuid,text,integer,integer)') is not null
    and to_regprocedure('public.prepare_job_payload_cleanup(uuid,text,bigint)') is not null
    and to_regprocedure('public.sweep_job_lifecycle(integer,timestamptz)') is not null
    and to_regprocedure('public.read_stream_lifecycle_metrics_v1()') is not null
    and has_function_privilege(
      'service_role',
      'public.acquire_job_event_stream(uuid,uuid,uuid,text,integer,integer)',
      'EXECUTE'
    )
    and has_function_privilege(
      'service_role', 'public.read_stream_lifecycle_metrics_v1()', 'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'public.acquire_job_event_stream(uuid,uuid,uuid,text,integer,integer)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated', 'public.read_stream_lifecycle_metrics_v1()', 'EXECUTE'
    )
    and exists (
      select 1 from storage.buckets
      where id = 'job-payloads' and public = false and file_size_limit = 8388608
    );
end;
$$;

revoke all on function public.runtime_healthcheck_v11()
  from public, anon, authenticated, service_role;
grant execute on function public.runtime_healthcheck_v11() to service_role;

commit;
