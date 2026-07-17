-- Platform authority v2: single-source Agent limits, O(1) stream admission,
-- process-scoped worker presence, server-authoritative chat turns, and an
-- outbox containing only owned delivery work. Historical migrations remain
-- immutable; old RPCs stay available for rolling compatibility.
begin;

-- Lifecycle rows without a real consumer must not be labelled as published.
-- Jobs and audit_log already hold their durable state, while authoritative
-- metrics derive terminal/poison counts directly from those records.
create or replace function public.suppress_unconsumed_job_lifecycle_outbox()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if new.topic in (
    'jobs.ready', 'jobs.terminal', 'jobs.cancel_requested', 'jobs.poison'
  ) then
    return null;
  end if;
  return new;
end;
$$;
revoke all on function public.suppress_unconsumed_job_lifecycle_outbox()
  from public, anon, authenticated, service_role;

drop trigger if exists suppress_unconsumed_job_lifecycle_outbox
  on public.job_outbox;
create trigger suppress_unconsumed_job_lifecycle_outbox
before insert on public.job_outbox
for each row execute function public.suppress_unconsumed_job_lifecycle_outbox();

delete from public.job_outbox
where topic in ('jobs.ready', 'jobs.terminal', 'jobs.cancel_requested', 'jobs.poison')
  and status <> 'published';

-- Agent execution limits are read from the same activated price contract that
-- admission uses. Requested and effective values are explicitly recorded and
-- therefore cannot drift from a stale literal in the enqueue function.
create or replace function public.enqueue_agent_task_job(
  input_user_id uuid,
  input_task_id uuid,
  input_goal text,
  input_repo text,
  input_session_id uuid,
  input_response_id uuid,
  input_user_message_id uuid,
  input_job_id uuid,
  input_auth_class text,
  input_idempotency_key text,
  input_input_hash text,
  input_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, auth, pg_temp
as $$
declare
  v_task public.agent_tasks%rowtype;
  v_result jsonb;
  v_now timestamptz := clock_timestamp();
  v_token_limit bigint;
  v_price_version integer;
  v_payload jsonb := coalesce(input_payload, '{}'::jsonb);
begin
  perform public.assert_agent_confirmation_actor(input_user_id);
  if input_task_id is null or input_session_id is null or input_response_id is null
     or input_user_message_id is null or input_job_id is null
     or length(coalesce(input_goal, '')) not between 1 and 10000
     or coalesce(input_repo, '') !~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'
     or input_auth_class not in ('anonymous', 'registered')
     or length(coalesce(input_idempotency_key, '')) not between 1 and 256
     or length(coalesce(input_input_hash, '')) not between 16 and 256
     or jsonb_typeof(v_payload) <> 'object' then
    raise exception 'invalid_agent_task_enqueue' using errcode = '22023';
  end if;

  select catalog.raw_token_cap, catalog.version
  into strict v_token_limit, v_price_version
  from public.job_price_activation_heads as head
  join public.job_price_activations as activation
    on activation.sku = head.sku
   and activation.price_version = head.price_version
   and activation.activation_generation = head.activation_generation
  join public.job_price_catalog as catalog
    on catalog.sku = head.sku and catalog.version = head.price_version
  where head.sku = 'agent.task'
  for key share of catalog;
  if v_token_limit is null or v_token_limit < 1 then
    raise exception 'agent_execution_policy_unavailable' using errcode = '55000';
  end if;

  if not exists (
    select 1 from public.code_sessions
    where id = input_session_id and user_id = input_user_id and repo = input_repo
  ) or not exists (
    select 1 from public.code_messages
    where id = input_user_message_id and session_id = input_session_id
      and user_id = input_user_id and role = 'user'
  ) then
    raise exception 'agent_task_context_conflict' using errcode = '23503';
  end if;

  insert into public.agent_tasks(
    id, user_id, goal, mode, repo, branch, status, meta, created_at, updated_at
  ) values (
    input_task_id, input_user_id, input_goal, 'auto', input_repo, 'main', 'queued',
    jsonb_build_object('authority', 'job-control-plane'), v_now, v_now
  ) on conflict (id) do nothing;
  select * into v_task from public.agent_tasks
  where id = input_task_id and user_id = input_user_id for update;
  if not found or v_task.repo is distinct from input_repo
     or v_task.status in ('completed', 'cancelled') then
    raise exception 'agent_task_state_conflict' using errcode = '23505';
  end if;

  v_payload := v_payload || jsonb_build_object(
    'executionLimits', jsonb_build_object(
      'schemaVersion', 1,
      'source', 'activated-price-catalog',
      'priceVersion', v_price_version,
      'requestedTokenLimit', v_token_limit,
      'effectiveTokenLimit', v_token_limit
    )
  );
  v_result := public.enqueue_job(
    input_job_id => input_job_id,
    input_type => 'agent.task',
    input_queue => 'agent',
    input_principal_id => input_user_id,
    input_auth_class => input_auth_class,
    input_subject => jsonb_build_object(
      'taskId', input_task_id, 'repo', input_repo,
      'sessionId', input_session_id, 'responseId', input_response_id,
      'userMessageId', input_user_message_id
    ),
    input_idempotency_key => input_idempotency_key,
    input_input_hash => input_input_hash,
    input_payload => v_payload,
    input_budget => jsonb_build_object(
      'wallTimeMs', 2700000, 'tokenLimit', v_token_limit,
      'sandboxTimeMs', 2400000, 'toolCallLimit', 256
    ),
    input_priority => 0,
    input_max_attempts => 3,
    input_available_at => v_now
  );
  update public.agent_tasks
  set status = 'queued', error = null, updated_at = v_now
  where id = input_task_id and user_id = input_user_id;
  return v_result || jsonb_build_object('taskId', input_task_id);
end;
$$;
revoke all on function public.enqueue_agent_task_job(
  uuid,uuid,text,text,uuid,uuid,uuid,uuid,text,text,text,jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.enqueue_agent_task_job(
  uuid,uuid,text,text,uuid,uuid,uuid,uuid,text,text,text,jsonb
) to service_role;

-- One process heartbeat carries exact capacity per queue. This reduces five
-- heartbeat RPCs to one without overstating capacity for low-concurrency queues.
create or replace function public.valid_job_worker_queue_capacities(input jsonb)
returns boolean
language sql
immutable
strict
set search_path = pg_catalog, pg_temp
as $$
  select jsonb_typeof(input) = 'object'
    and (select count(*) from jsonb_object_keys(input)) between 1 and 32
    and not exists (
      select 1 from jsonb_each_text(input) as entry(queue_name, capacity)
      where queue_name !~ '^[a-z][a-z0-9_.-]{0,63}$'
         or capacity !~ '^[0-9]{1,2}$'
         or capacity::integer not between 1 and 16
    )
    and (
      select coalesce(sum(capacity::integer), 0)
      from jsonb_each_text(input) as entry(queue_name, capacity)
    ) between 1 and 256;
$$;
revoke all on function public.valid_job_worker_queue_capacities(jsonb)
  from public, anon, authenticated, service_role;

alter table public.job_worker_heartbeats
  add column if not exists queue_capacities jsonb not null default '{}'::jsonb;
update public.job_worker_heartbeats as heartbeat
set queue_capacities = (
  select jsonb_object_agg(queue_name, greatest(1, heartbeat.capacity / cardinality(heartbeat.queues))) as value
  from unnest(heartbeat.queues) as queue_name
)
where heartbeat.queue_capacities = '{}'::jsonb;
alter table public.job_worker_heartbeats
  drop constraint if exists job_worker_queue_capacities_check;
alter table public.job_worker_heartbeats
  add constraint job_worker_queue_capacities_check
  check (public.valid_job_worker_queue_capacities(queue_capacities));

create or replace function public.heartbeat_job_worker_v2(
  input_worker_id text,
  input_revision text,
  input_queue_capacities jsonb,
  input_started_at timestamptz,
  input_draining boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_queues text[];
  v_capacity integer;
begin
  if input_worker_id is null or length(input_worker_id) not between 1 and 256
     or input_worker_id ~ '[[:cntrl:]]'
     or coalesce(input_revision, '') !~ '^(unknown|[0-9a-f]{7,64})$'
     or input_queue_capacities is null
     or not coalesce(public.valid_job_worker_queue_capacities(input_queue_capacities), false)
     or input_started_at is null or input_started_at > v_now + interval '5 minutes'
     or input_draining is null then
    raise exception 'invalid_job_worker_heartbeat_v2' using errcode = '22023';
  end if;
  select array_agg(queue_name order by queue_name), sum(capacity::integer)
  into strict v_queues, v_capacity
  from jsonb_each_text(input_queue_capacities) as entry(queue_name, capacity);

  insert into public.job_worker_heartbeats(
    worker_id, revision, queues, capacity, queue_capacities,
    draining, started_at, heartbeat_at
  ) values (
    input_worker_id, input_revision, v_queues, v_capacity, input_queue_capacities,
    input_draining, least(input_started_at, v_now), v_now
  ) on conflict (worker_id) do update
  set revision = excluded.revision,
      queues = excluded.queues,
      capacity = excluded.capacity,
      queue_capacities = excluded.queue_capacities,
      draining = excluded.draining,
      started_at = least(public.job_worker_heartbeats.started_at, excluded.started_at),
      heartbeat_at = excluded.heartbeat_at;

  with stale as (
    select worker_id from public.job_worker_heartbeats
    where heartbeat_at < v_now - interval '7 days'
    order by heartbeat_at, worker_id limit 100
    for update skip locked
  )
  delete from public.job_worker_heartbeats as heartbeat using stale
  where heartbeat.worker_id = stale.worker_id;

  return jsonb_build_object(
    'accepted', true, 'heartbeatAt', v_now, 'draining', input_draining,
    'queues', to_jsonb(v_queues), 'capacity', v_capacity
  );
end;
$$;
revoke all on function public.heartbeat_job_worker_v2(text,text,jsonb,timestamptz,boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.heartbeat_job_worker_v2(text,text,jsonb,timestamptz,boolean)
  to service_role;

create or replace function public.read_job_worker_readiness_v3(
  input_required_queues text[],
  input_max_age_seconds integer,
  input_revision text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
set statement_timeout = '3s'
as $$
declare
  v_now timestamptz := clock_timestamp();
  covered text[];
  missing text[];
  active_workers bigint;
  total_capacity bigint;
  stale_workers bigint;
  draining_workers bigint;
  freshest_heartbeat_at timestamptz;
  oldest_active_heartbeat_at timestamptz;
  queue_metrics jsonb;
begin
  if input_required_queues is null
     or cardinality(input_required_queues) not between 1 and 32
     or exists (
       select 1 from unnest(input_required_queues) as queue_name
       where queue_name is null or queue_name !~ '^[a-z][a-z0-9_.-]{0,63}$'
     )
     or (select count(distinct queue_name) from unnest(input_required_queues) as queue_name)
       <> cardinality(input_required_queues)
     or input_max_age_seconds is null or input_max_age_seconds not between 5 and 300
     or coalesce(input_revision, '') !~ '^(unknown|[0-9a-f]{7,64})$'
     or input_revision <> btrim(input_revision) then
    raise exception 'invalid_job_worker_readiness_v3' using errcode = '22023';
  end if;

  with active as (
    select queues from public.job_worker_heartbeats
    where revision = input_revision and not draining
      and heartbeat_at >= v_now - make_interval(secs => input_max_age_seconds)
  ), expanded as (
    select distinct queue_name
    from active cross join lateral unnest(active.queues) as queue_name
  )
  select coalesce(array_agg(queue_name order by queue_name), array[]::text[])
  into covered from expanded;

  select coalesce(array_agg(required_queue order by required_queue), array[]::text[])
  into missing
  from unnest(input_required_queues) as required_queue
  where not (required_queue = any(covered));

  select
    count(*) filter (where not draining and heartbeat_at >= v_now - make_interval(secs => input_max_age_seconds)),
    coalesce(sum(capacity) filter (where not draining and heartbeat_at >= v_now - make_interval(secs => input_max_age_seconds)), 0),
    count(*) filter (where not draining and heartbeat_at < v_now - make_interval(secs => input_max_age_seconds)),
    count(*) filter (where draining),
    max(heartbeat_at) filter (where not draining),
    min(heartbeat_at) filter (where not draining and heartbeat_at >= v_now - make_interval(secs => input_max_age_seconds))
  into active_workers, total_capacity, stale_workers, draining_workers,
    freshest_heartbeat_at, oldest_active_heartbeat_at
  from public.job_worker_heartbeats where revision = input_revision;

  select coalesce(jsonb_agg(jsonb_build_object(
    'queue', required_queue,
    'ready', queue_state.active_workers > 0,
    'activeWorkers', queue_state.active_workers,
    'totalCapacity', queue_state.total_capacity,
    'freshestHeartbeatAgeSeconds', case
      when queue_state.freshest_heartbeat_at is null then null
      else greatest(0, extract(epoch from (v_now - queue_state.freshest_heartbeat_at)))
    end
  ) order by required_queue), '[]'::jsonb)
  into queue_metrics
  from unnest(input_required_queues) as required_queue
  cross join lateral (
    select count(*) as active_workers,
      coalesce(sum((worker.queue_capacities->>required_queue)::integer), 0) as total_capacity,
      max(worker.heartbeat_at) as freshest_heartbeat_at
    from public.job_worker_heartbeats as worker
    where worker.revision = input_revision and not worker.draining
      and worker.heartbeat_at >= v_now - make_interval(secs => input_max_age_seconds)
      and worker.queue_capacities ? required_queue
  ) as queue_state;

  return jsonb_build_object(
    'schemaVersion', 1, 'generatedAt', v_now,
    'ready', cardinality(missing) = 0,
    'activeWorkers', active_workers, 'totalCapacity', total_capacity,
    'staleWorkers', stale_workers, 'drainingWorkers', draining_workers,
    'freshestHeartbeatAgeSeconds', case when freshest_heartbeat_at is null then null
      else greatest(0, extract(epoch from (v_now - freshest_heartbeat_at))) end,
    'oldestActiveHeartbeatAgeSeconds', case when oldest_active_heartbeat_at is null then null
      else greatest(0, extract(epoch from (v_now - oldest_active_heartbeat_at))) end,
    'requiredQueues', to_jsonb(input_required_queues),
    'coveredQueues', to_jsonb(covered), 'missingQueues', to_jsonb(missing),
    'queues', queue_metrics
  );
end;
$$;
revoke all on function public.read_job_worker_readiness_v3(text[],integer,text)
  from public, anon, authenticated, service_role;
grant execute on function public.read_job_worker_readiness_v3(text[],integer,text)
  to service_role;

-- Exact stream limits use four constant-time counters instead of a table scan
-- and global advisory lock. The global counter row is a tiny O(1) serialization
-- point; principal, address and job counters isolate all other contention.
create table if not exists public.job_stream_capacity_counters (
  scope text not null check (scope in ('global', 'principal', 'address', 'job')),
  scope_key text not null check (length(scope_key) between 1 and 128),
  active_count integer not null check (active_count >= 0),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (scope, scope_key)
);
alter table public.job_stream_capacity_counters enable row level security;
revoke all on table public.job_stream_capacity_counters
  from public, anon, authenticated, service_role;

delete from public.job_stream_leases where expires_at <= clock_timestamp();
delete from public.job_stream_capacity_counters;
insert into public.job_stream_capacity_counters(scope, scope_key, active_count)
select scope, scope_key, count(*)::integer
from (
  select 'global'::text as scope, 'all'::text as scope_key from public.job_stream_leases
  union all select 'principal', principal_id::text from public.job_stream_leases
  union all select 'address', address_hash from public.job_stream_leases
  union all select 'job', job_id::text from public.job_stream_leases
) as dimensions
group by scope, scope_key;

create or replace function public.adjust_job_stream_capacity_counter()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  delta integer := case when tg_op = 'INSERT' then 1 else -1 end;
  lease_principal_id uuid;
  lease_job_id uuid;
  lease_address_hash text;
  dimension record;
  accepted integer;
begin
  if tg_op = 'INSERT' then
    lease_principal_id := new.principal_id;
    lease_job_id := new.job_id;
    lease_address_hash := new.address_hash;
  else
    lease_principal_id := old.principal_id;
    lease_job_id := old.job_id;
    lease_address_hash := old.address_hash;
  end if;
  for dimension in
    select * from (values
      ('global'::text, 'all'::text),
      ('principal'::text, lease_principal_id::text),
      ('address'::text, lease_address_hash),
      ('job'::text, lease_job_id::text)
    ) as valueset(scope, scope_key)
    order by scope, scope_key
  loop
    insert into public.job_stream_capacity_counters(scope, scope_key, active_count)
    values (dimension.scope, dimension.scope_key, greatest(delta, 0))
    on conflict (scope, scope_key) do update
    set active_count = public.job_stream_capacity_counters.active_count + delta,
        updated_at = clock_timestamp()
    where public.job_stream_capacity_counters.active_count + delta >= 0
    returning active_count into accepted;
    if accepted is null then
      raise exception 'job_stream_capacity_counter_underflow' using errcode = '55000';
    end if;
  end loop;
  if tg_op = 'INSERT' then return new; end if;
  return old;
end;
$$;
revoke all on function public.adjust_job_stream_capacity_counter()
  from public, anon, authenticated, service_role;
drop trigger if exists adjust_job_stream_capacity_counter on public.job_stream_leases;
create trigger adjust_job_stream_capacity_counter
after insert or delete on public.job_stream_leases
for each row execute function public.adjust_job_stream_capacity_counter();

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
set search_path = pg_catalog, public, pg_temp
as $$
declare
  existing public.job_stream_leases%rowtype;
  v_now timestamptz := clock_timestamp();
  v_hard_expires_at timestamptz;
  v_expires_at timestamptz;
  global_count integer;
  principal_count integer;
  address_count integer;
  job_count integer;
  inserted integer;
begin
  if input_stream_id is null or input_principal_id is null or input_job_id is null
     or coalesce(input_address_hash, '') !~ '^[0-9a-f]{64}$'
     or input_lease_seconds is null or input_lease_seconds not between 15 and 60
     or input_max_seconds is null or input_max_seconds not between 60 and 900 then
    raise exception 'invalid_job_stream_admission' using errcode = '22023';
  end if;

  with expired as (
    select id from public.job_stream_leases
    where expires_at <= v_now
    order by expires_at, id limit 64
    for update skip locked
  )
  delete from public.job_stream_leases as lease using expired
  where lease.id = expired.id;

  select * into existing from public.job_stream_leases
  where id = input_stream_id for update;
  if found then
    if existing.principal_id <> input_principal_id
       or existing.job_id <> input_job_id
       or existing.address_hash <> input_address_hash then
      raise exception 'job_stream_idempotency_conflict' using errcode = '23505';
    end if;
    return jsonb_build_object(
      'acquired', true, 'reason', null, 'streamId', existing.id,
      'leaseExpiresAt', existing.expires_at,
      'hardExpiresAt', existing.hard_expires_at, 'retryAfterSeconds', 0
    );
  end if;

  perform 1 from public.jobs
  where id = input_job_id and principal_id = input_principal_id;
  if not found then
    return jsonb_build_object('acquired', false, 'reason', 'not_found', 'retryAfterSeconds', 5);
  end if;

  insert into public.job_stream_capacity_counters(scope, scope_key, active_count)
  values
    ('global', 'all', 0),
    ('principal', input_principal_id::text, 0),
    ('address', input_address_hash, 0),
    ('job', input_job_id::text, 0)
  on conflict (scope, scope_key) do nothing;
  perform 1 from public.job_stream_capacity_counters
  where (scope, scope_key) in (
    ('global', 'all'),
    ('principal', input_principal_id::text),
    ('address', input_address_hash),
    ('job', input_job_id::text)
  ) order by scope, scope_key for update;

  select
    max(active_count) filter (where scope = 'global'),
    max(active_count) filter (where scope = 'principal'),
    max(active_count) filter (where scope = 'address'),
    max(active_count) filter (where scope = 'job')
  into strict global_count, principal_count, address_count, job_count
  from public.job_stream_capacity_counters
  where (scope, scope_key) in (
    ('global', 'all'),
    ('principal', input_principal_id::text),
    ('address', input_address_hash),
    ('job', input_job_id::text)
  );
  if global_count >= 256 or principal_count >= 4
     or address_count >= 12 or job_count >= 2 then
    return jsonb_build_object('acquired', false, 'reason', 'capacity', 'retryAfterSeconds', 5);
  end if;

  v_hard_expires_at := v_now + make_interval(secs => input_max_seconds);
  v_expires_at := least(v_hard_expires_at, v_now + make_interval(secs => input_lease_seconds));
  insert into public.job_stream_leases(
    id, principal_id, job_id, address_hash, acquired_at, expires_at, hard_expires_at
  ) values (
    input_stream_id, input_principal_id, input_job_id, input_address_hash,
    v_now, v_expires_at, v_hard_expires_at
  ) on conflict (id) do nothing;
  get diagnostics inserted = row_count;
  if inserted = 0 then
    select * into strict existing from public.job_stream_leases where id = input_stream_id;
    if existing.principal_id <> input_principal_id
       or existing.job_id <> input_job_id
       or existing.address_hash <> input_address_hash then
      raise exception 'job_stream_idempotency_conflict' using errcode = '23505';
    end if;
    v_expires_at := existing.expires_at;
    v_hard_expires_at := existing.hard_expires_at;
  end if;
  return jsonb_build_object(
    'acquired', true, 'reason', null, 'streamId', input_stream_id,
    'leaseExpiresAt', v_expires_at, 'hardExpiresAt', v_hard_expires_at,
    'retryAfterSeconds', 0
  );
end;
$$;
revoke all on function public.acquire_job_event_stream(uuid,uuid,uuid,text,integer,integer)
  from public, anon, authenticated, service_role;
grant execute on function public.acquire_job_event_stream(uuid,uuid,uuid,text,integer,integer)
  to service_role;

-- A chat turn is now one service-owned transaction: optional conversation,
-- user message, assistant placeholder, Job and generation projection either all
-- commit or all roll back. Replays validate immutable identity and content.
create or replace function public.enqueue_chat_turn_v1(
  input_user_id uuid,
  input_conversation_id uuid,
  input_create_conversation boolean,
  input_project_id uuid,
  input_conversation_title text,
  input_user_message_id uuid,
  input_user_content text,
  input_user_images jsonb,
  input_user_created_at timestamptz,
  input_assistant_message_id uuid,
  input_job_id uuid,
  input_auth_class text,
  input_idempotency_key text,
  input_input_hash text,
  input_payload jsonb,
  input_budget jsonb,
  input_queue text,
  input_max_attempts integer
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, auth, pg_temp
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_created boolean := false;
  v_images jsonb := input_user_images;
  v_result jsonb;
  v_message public.messages%rowtype;
begin
  if input_user_id is null or input_conversation_id is null
     or input_create_conversation is null or input_user_message_id is null
     or input_assistant_message_id is null or input_job_id is null
     or input_user_content is null or octet_length(input_user_content) > 1048576
     or length(coalesce(input_conversation_title, '')) not between 1 and 200
     or input_auth_class not in ('anonymous', 'registered')
     or length(coalesce(input_idempotency_key, '')) not between 1 and 256
     or length(coalesce(input_input_hash, '')) not between 16 and 256
     or jsonb_typeof(coalesce(input_payload, '{}'::jsonb)) <> 'object'
     or jsonb_typeof(coalesce(input_budget, '{}'::jsonb)) <> 'object'
     or input_queue not in ('chat', 'media')
     or input_max_attempts not between 1 and 3
     or input_user_created_at is null
     or input_user_created_at < v_now - interval '30 days'
     or input_user_created_at > v_now + interval '10 minutes'
     or (v_images is not null and (
       jsonb_typeof(v_images) <> 'object'
       or octet_length(v_images::text) > 8388608
       or jsonb_typeof(coalesce(v_images->'refs', '[]'::jsonb)) <> 'array'
       or jsonb_array_length(coalesce(v_images->'refs', '[]'::jsonb)) > 8
     )) then
    raise exception 'invalid_chat_turn_v1' using errcode = '22023';
  end if;
  if v_images is not null and exists (
    select 1 from jsonb_array_elements(v_images->'refs') as item
    where jsonb_typeof(item) <> 'string'
  ) then
    raise exception 'invalid_chat_turn_images_v1' using errcode = '22023';
  end if;

  if input_create_conversation then
    if input_project_id is not null and not exists (
      select 1 from public.projects
      where id = input_project_id and user_id = input_user_id
    ) then
      raise exception 'chat_turn_project_not_found' using errcode = '23503';
    end if;
    insert into public.conversations(id, user_id, title, project_id, created_at, updated_at)
    values (
      input_conversation_id, input_user_id, input_conversation_title,
      input_project_id, v_now, v_now
    ) on conflict (id) do nothing;
    v_created := found;
  end if;

  perform 1 from public.conversations
  where id = input_conversation_id and user_id = input_user_id
  for update;
  if not found then
    raise exception 'chat_turn_conversation_not_found' using errcode = '23503';
  end if;

  insert into public.messages(
    id, conversation_id, user_id, role, content, images, thinking,
    status, created_at, updated_at
  ) values (
    input_user_message_id, input_conversation_id, input_user_id, 'user',
    input_user_content, v_images, null, 'terminal', input_user_created_at, v_now
  ) on conflict (id) do nothing;
  select * into v_message from public.messages
  where id = input_user_message_id for update;
  if not found or v_message.user_id <> input_user_id
     or v_message.conversation_id <> input_conversation_id
     or v_message.role <> 'user'
     or v_message.content is distinct from input_user_content
     or v_message.images is distinct from v_images
     or v_message.generation_id is not null then
    raise exception 'chat_turn_user_message_conflict' using errcode = '23505';
  end if;

  insert into public.messages(
    id, conversation_id, user_id, role, content, images, thinking,
    status, created_at, updated_at
  ) values (
    input_assistant_message_id, input_conversation_id, input_user_id,
    'assistant', '', null, null, 'draft', v_now, v_now
  ) on conflict (id) do nothing;
  select * into v_message from public.messages
  where id = input_assistant_message_id for update;
  if not found or v_message.user_id <> input_user_id
     or v_message.conversation_id <> input_conversation_id
     or v_message.role <> 'assistant'
     or (v_message.generation_id is not null and v_message.generation_id <> input_job_id) then
    raise exception 'chat_turn_assistant_message_conflict' using errcode = '23505';
  end if;

  v_result := public.enqueue_job(
    input_job_id => input_job_id,
    input_type => 'chat.generation',
    input_queue => input_queue,
    input_principal_id => input_user_id,
    input_auth_class => input_auth_class,
    input_subject => jsonb_build_object(
      'conversationId', input_conversation_id,
      'userMessageId', input_user_message_id,
      'assistantMessageId', input_assistant_message_id
    ),
    input_idempotency_key => input_idempotency_key,
    input_input_hash => input_input_hash,
    input_payload => input_payload,
    input_budget => input_budget,
    input_priority => 0,
    input_max_attempts => input_max_attempts,
    input_available_at => v_now
  );
  update public.conversations set updated_at = v_now
  where id = input_conversation_id and user_id = input_user_id;
  return v_result || jsonb_build_object(
    'conversationId', input_conversation_id,
    'conversationCreated', v_created,
    'userMessageId', input_user_message_id,
    'assistantMessageId', input_assistant_message_id
  );
end;
$$;
revoke all on function public.enqueue_chat_turn_v1(
  uuid,uuid,boolean,uuid,text,uuid,text,jsonb,timestamptz,uuid,uuid,
  text,text,text,jsonb,jsonb,text,integer
) from public, anon, authenticated, service_role;
grant execute on function public.enqueue_chat_turn_v1(
  uuid,uuid,boolean,uuid,text,uuid,text,jsonb,timestamptz,uuid,uuid,
  text,text,text,jsonb,jsonb,text,integer
) to service_role;

-- Regeneration is also one service-owned transaction. The expected tail is a
-- compare-and-swap fence against stale browser state. The prior branch remains
-- untouched unless cleanup receipts, the replacement placeholder, admission,
-- the Job and its generation projection can all commit together.
create or replace function public.enqueue_chat_regeneration_v1(
  input_user_id uuid,
  input_conversation_id uuid,
  input_operation text,
  input_source_user_message_id uuid,
  input_target_assistant_message_id uuid,
  input_expected_tail_message_id uuid,
  input_user_content text,
  input_assistant_message_id uuid,
  input_job_id uuid,
  input_auth_class text,
  input_idempotency_key text,
  input_input_hash text,
  input_payload jsonb,
  input_budget jsonb,
  input_queue text,
  input_max_attempts integer,
  input_cleanup_object_keys text[] default array[]::text[]
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, auth, pg_temp
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_source public.messages%rowtype;
  v_tail public.messages%rowtype;
  v_target public.messages%rowtype;
  v_existing_job public.jobs%rowtype;
  v_result jsonb;
  v_replaced_ids uuid[] := array[]::uuid[];
  v_replaced_generation_ids uuid[] := array[]::uuid[];
  v_replaced_count integer := 0;
  v_deleted_count integer := 0;
  v_cleanup_keys text[] := coalesce(input_cleanup_object_keys, array[]::text[]);
begin
  if input_user_id is null or input_conversation_id is null
     or input_operation not in ('replace-assistant', 'replace-from-user')
     or input_source_user_message_id is null or input_expected_tail_message_id is null
     or input_assistant_message_id is null or input_job_id is null
     or input_user_content is null or length(btrim(input_user_content)) < 1
     or octet_length(input_user_content) > 1048576
     or input_auth_class not in ('anonymous', 'registered')
     or length(coalesce(input_idempotency_key, '')) not between 1 and 256
     or length(coalesce(input_input_hash, '')) not between 16 and 256
     or jsonb_typeof(coalesce(input_payload, '{}'::jsonb)) <> 'object'
     or jsonb_typeof(coalesce(input_budget, '{}'::jsonb)) <> 'object'
     or input_queue not in ('chat', 'media')
     or input_max_attempts not between 1 and 3
     or input_assistant_message_id in (
       input_source_user_message_id, input_expected_tail_message_id
     )
     or input_job_id = input_assistant_message_id
     or cardinality(v_cleanup_keys) > 400
     or cardinality(v_cleanup_keys) <> (
       select count(distinct object_key) from unnest(v_cleanup_keys) as object_key
     )
     or (input_operation = 'replace-assistant' and (
       input_target_assistant_message_id is null
       or input_target_assistant_message_id <> input_expected_tail_message_id
     ))
     or (input_operation = 'replace-from-user'
       and input_target_assistant_message_id is not null) then
    raise exception 'invalid_chat_regeneration_v1' using errcode = '22023';
  end if;

  -- A lost response must be replayable after the old branch has already gone.
  select * into v_existing_job
  from public.jobs
  where principal_id = input_user_id and idempotency_key = input_idempotency_key
  for update;
  if found then
    if v_existing_job.id <> input_job_id
       or v_existing_job.type <> 'chat.generation'
       or v_existing_job.input_hash <> input_input_hash
       or v_existing_job.subject->>'conversationId' <> input_conversation_id::text
       or v_existing_job.subject->>'userMessageId' <> input_source_user_message_id::text
       or v_existing_job.subject->>'assistantMessageId' <> input_assistant_message_id::text
       or v_existing_job.subject->>'regenerationOperation' <> input_operation
       or v_existing_job.subject->>'replacedTailMessageId' <> input_expected_tail_message_id::text then
      raise exception 'chat_regeneration_idempotency_conflict' using errcode = '23505';
    end if;
    return jsonb_build_object(
      'enqueued', false, 'replayed', true,
      'conversationId', input_conversation_id,
      'userMessageId', input_source_user_message_id,
      'assistantMessageId', input_assistant_message_id,
      'operation', input_operation,
      'job', public.job_contract_json(v_existing_job)
    );
  end if;

  perform 1 from public.conversations
  where id = input_conversation_id and user_id = input_user_id
  for update;
  if not found then
    raise exception 'chat_regeneration_conversation_not_found' using errcode = '23503';
  end if;
  if exists (
    select 1 from public.jobs
    where principal_id = input_user_id and type = 'chat.generation'
      and subject->>'conversationId' = input_conversation_id::text
      and status in ('queued', 'leased', 'running', 'awaiting_input', 'cancelling')
  ) or exists (
    select 1 from public.chat_generations
    where user_id = input_user_id and conversation_id = input_conversation_id
      and status in ('queued', 'running')
  ) then
    raise exception 'chat_regeneration_active' using errcode = '55000';
  end if;

  select * into v_source from public.messages
  where id = input_source_user_message_id
    and conversation_id = input_conversation_id
    and user_id = input_user_id and role = 'user'
  for update;
  if not found or v_source.generation_id is not null then
    raise exception 'chat_regeneration_source_not_found' using errcode = '23503';
  end if;
  select * into v_tail from public.messages
  where conversation_id = input_conversation_id and user_id = input_user_id
  order by seq desc limit 1 for update;
  if not found or v_tail.id <> input_expected_tail_message_id
     or v_tail.seq < v_source.seq then
    raise exception 'chat_regeneration_stale_branch' using errcode = '40001';
  end if;

  perform 1 from public.messages
  where conversation_id = input_conversation_id and user_id = input_user_id
    and seq > v_source.seq
  order by seq for update;
  select
    count(*),
    coalesce(array_agg(id order by seq), array[]::uuid[]),
    coalesce(
      array_agg(generation_id order by seq) filter (where generation_id is not null),
      array[]::uuid[]
    )
  into v_replaced_count, v_replaced_ids, v_replaced_generation_ids
  from public.messages
  where conversation_id = input_conversation_id and user_id = input_user_id
    and seq > v_source.seq;
  if v_replaced_count > 500 then
    raise exception 'chat_regeneration_branch_too_large' using errcode = '54000';
  end if;

  if input_operation = 'replace-assistant' then
    select * into v_target from public.messages
    where id = input_target_assistant_message_id
      and conversation_id = input_conversation_id
      and user_id = input_user_id and role = 'assistant'
    for update;
    if not found or v_target.id <> v_tail.id or v_replaced_count <> 1
       or v_replaced_ids[1] <> v_target.id
       or v_source.content is distinct from input_user_content then
      raise exception 'chat_regeneration_assistant_conflict' using errcode = '23505';
    end if;
  end if;

  if exists (
    select 1 from unnest(v_cleanup_keys) as object_key
    where object_key is null
      or object_key !~* (
        '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/'
        || '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/'
        || '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/'
        || '[A-Za-z0-9][A-Za-z0-9_-]{0,127}[.](png|jpg|webp|gif|mp4|webm|mov)$'
      )
      or split_part(object_key, '/', 1) <> input_user_id::text
      or split_part(object_key, '/', 2) <> input_conversation_id::text
      or not (split_part(object_key, '/', 3)::uuid = any(v_replaced_generation_ids))
  ) then
    raise exception 'invalid_chat_regeneration_cleanup_key' using errcode = '22023';
  end if;

  insert into public.generated_media_cleanup_jobs(
    object_key, user_id, conversation_id, generation_id, reason
  )
  select cleanup.object_key, input_user_id, input_conversation_id,
    cleanup.generation_id, 'history_delete'
  from (
    select asset.object_key, asset.job_id as generation_id
    from public.job_assets as asset
    where asset.principal_id = input_user_id
      and asset.job_id = any(v_replaced_generation_ids)
      and asset.state <> 'deleted'
    union
    select object_key, split_part(object_key, '/', 3)::uuid
    from unnest(v_cleanup_keys) as object_key
  ) as cleanup
  on conflict (object_key) do update set
    reason = excluded.reason,
    updated_at = v_now,
    completed_at = null;

  delete from public.messages
  where conversation_id = input_conversation_id and user_id = input_user_id
    and seq > v_source.seq;
  get diagnostics v_deleted_count = row_count;
  if v_deleted_count <> v_replaced_count then
    raise exception 'chat_regeneration_branch_changed' using errcode = '40001';
  end if;

  if input_operation = 'replace-from-user'
     and v_source.content is distinct from input_user_content then
    update public.messages
    set content = input_user_content,
        content_parts = jsonb_build_array(
          jsonb_build_object('type', 'text', 'text', input_user_content)
        )
    where id = v_source.id and conversation_id = input_conversation_id
      and user_id = input_user_id and role = 'user';
    if not found then
      raise exception 'chat_regeneration_source_changed' using errcode = '40001';
    end if;
  end if;

  insert into public.messages(
    id, conversation_id, user_id, role, content, images, thinking,
    status, created_at, updated_at
  ) values (
    input_assistant_message_id, input_conversation_id, input_user_id,
    'assistant', '', null, null, 'draft', v_now, v_now
  );
  v_result := public.enqueue_job(
    input_job_id => input_job_id,
    input_type => 'chat.generation',
    input_queue => input_queue,
    input_principal_id => input_user_id,
    input_auth_class => input_auth_class,
    input_subject => jsonb_build_object(
      'conversationId', input_conversation_id,
      'userMessageId', input_source_user_message_id,
      'assistantMessageId', input_assistant_message_id,
      'regenerationOperation', input_operation,
      'replacedTailMessageId', input_expected_tail_message_id
    ),
    input_idempotency_key => input_idempotency_key,
    input_input_hash => input_input_hash,
    input_payload => input_payload,
    input_budget => input_budget,
    input_priority => 0,
    input_max_attempts => input_max_attempts,
    input_available_at => v_now
  );
  update public.conversations set updated_at = v_now
  where id = input_conversation_id and user_id = input_user_id;
  return v_result || jsonb_build_object(
    'conversationId', input_conversation_id,
    'userMessageId', input_source_user_message_id,
    'assistantMessageId', input_assistant_message_id,
    'operation', input_operation,
    'replacedMessageIds', to_jsonb(v_replaced_ids)
  );
end;
$$;
revoke all on function public.enqueue_chat_regeneration_v1(
  uuid,uuid,text,uuid,uuid,uuid,text,uuid,uuid,text,text,text,
  jsonb,jsonb,text,integer,text[]
) from public, anon, authenticated, service_role;
grant execute on function public.enqueue_chat_regeneration_v1(
  uuid,uuid,text,uuid,uuid,uuid,text,uuid,uuid,text,text,text,
  jsonb,jsonb,text,integer,text[]
) to service_role;

create or replace function public.runtime_healthcheck_v15()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select public.runtime_healthcheck_v14()
    and to_regclass('public.job_stream_capacity_counters') is not null
    and to_regprocedure('public.heartbeat_job_worker_v2(text,text,jsonb,timestamptz,boolean)') is not null
    and to_regprocedure('public.read_job_worker_readiness_v3(text[],integer,text)') is not null
    and to_regprocedure(
      'public.enqueue_chat_turn_v1(uuid,uuid,boolean,uuid,text,uuid,text,jsonb,timestamptz,uuid,uuid,text,text,text,jsonb,jsonb,text,integer)'
    ) is not null
    and to_regprocedure(
      'public.enqueue_chat_regeneration_v1(uuid,uuid,text,uuid,uuid,uuid,text,uuid,uuid,text,text,text,jsonb,jsonb,text,integer,text[])'
    ) is not null
    and exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'job_worker_heartbeats'
        and column_name = 'queue_capacities' and data_type = 'jsonb'
    )
    and exists (
      select 1 from pg_catalog.pg_trigger
      where tgrelid = 'public.job_stream_leases'::regclass
        and tgname = 'adjust_job_stream_capacity_counter'
        and tgenabled = 'O' and not tgisinternal
    )
    and exists (
      select 1 from pg_catalog.pg_trigger
      where tgrelid = 'public.job_outbox'::regclass
        and tgname = 'suppress_unconsumed_job_lifecycle_outbox'
        and tgenabled = 'O' and not tgisinternal
    )
    and has_function_privilege(
      'service_role',
      'public.heartbeat_job_worker_v2(text,text,jsonb,timestamptz,boolean)',
      'EXECUTE'
    )
    and has_function_privilege(
      'service_role', 'public.read_job_worker_readiness_v3(text[],integer,text)', 'EXECUTE'
    )
    and has_function_privilege(
      'service_role',
      'public.enqueue_chat_turn_v1(uuid,uuid,boolean,uuid,text,uuid,text,jsonb,timestamptz,uuid,uuid,text,text,text,jsonb,jsonb,text,integer)',
      'EXECUTE'
    )
    and has_function_privilege(
      'service_role',
      'public.enqueue_chat_regeneration_v1(uuid,uuid,text,uuid,uuid,uuid,text,uuid,uuid,text,text,text,jsonb,jsonb,text,integer,text[])',
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'public.enqueue_chat_turn_v1(uuid,uuid,boolean,uuid,text,uuid,text,jsonb,timestamptz,uuid,uuid,text,text,text,jsonb,jsonb,text,integer)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'public.enqueue_chat_regeneration_v1(uuid,uuid,text,uuid,uuid,uuid,text,uuid,uuid,text,text,text,jsonb,jsonb,text,integer,text[])',
      'EXECUTE'
    )
    and not has_table_privilege(
      'service_role', 'public.job_stream_capacity_counters',
      'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
    );
$$;
revoke all on function public.runtime_healthcheck_v15()
  from public, anon, authenticated, service_role;
grant execute on function public.runtime_healthcheck_v15() to service_role;

comment on function public.enqueue_chat_turn_v1(
  uuid,uuid,boolean,uuid,text,uuid,text,jsonb,timestamptz,uuid,uuid,
  text,text,text,jsonb,jsonb,text,integer
) is 'Atomically persists one user chat turn and its durable generation authority.';
comment on function public.enqueue_chat_regeneration_v1(
  uuid,uuid,text,uuid,uuid,uuid,text,uuid,uuid,text,text,text,
  jsonb,jsonb,text,integer,text[]
) is 'Atomically replaces a fenced chat branch and starts its durable generation.';
comment on table public.job_stream_capacity_counters is
  'Exact O(1) distributed SSE admission counters maintained from stream lease rows.';

commit;
