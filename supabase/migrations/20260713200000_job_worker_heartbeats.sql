-- Database-authoritative worker presence. Readiness must prove that fresh,
-- non-draining consumers cover every production queue; a schema-only queue
-- check is not enough to accept expensive commands.
begin;

create table if not exists public.job_worker_heartbeats (
  worker_id text primary key,
  revision text not null,
  queues text[] not null,
  capacity integer not null,
  draining boolean not null default false,
  started_at timestamptz not null,
  heartbeat_at timestamptz not null default now(),
  constraint job_worker_heartbeats_identity_check check (
    length(worker_id) between 1 and 256
    and revision ~ '^(unknown|[0-9a-f]{7,64})$'
  ),
  constraint job_worker_heartbeats_shape_check check (
    cardinality(queues) between 1 and 32
    and capacity between 1 and 256
    and heartbeat_at >= started_at
  )
);

alter table public.job_worker_heartbeats enable row level security;
revoke all on table public.job_worker_heartbeats
  from public, anon, authenticated, service_role;

create index if not exists job_worker_heartbeats_fresh_idx
  on public.job_worker_heartbeats(heartbeat_at desc)
  where not draining;

create or replace function public.heartbeat_job_worker(
  input_worker_id text,
  input_revision text,
  input_queues text[],
  input_capacity integer,
  input_started_at timestamptz,
  input_draining boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := clock_timestamp();
begin
  if input_worker_id is null or length(input_worker_id) not between 1 and 256
     or input_worker_id ~ '[[:cntrl:]]'
     or coalesce(input_revision, '') !~ '^(unknown|[0-9a-f]{7,64})$'
     or input_queues is null or cardinality(input_queues) not between 1 and 32
     or exists (
       select 1 from unnest(input_queues) as queue_name
       where queue_name is null or queue_name !~ '^[a-z][a-z0-9_.-]{0,63}$'
     )
     or (select count(distinct queue_name) from unnest(input_queues) as queue_name)
       <> cardinality(input_queues)
     or input_capacity is null or input_capacity not between 1 and 256
     or input_started_at is null or input_started_at > v_now + interval '5 minutes'
     or input_draining is null then
    raise exception 'invalid_job_worker_heartbeat' using errcode = '22023';
  end if;

  insert into public.job_worker_heartbeats(
    worker_id, revision, queues, capacity, draining, started_at, heartbeat_at
  ) values (
    input_worker_id, input_revision, input_queues, input_capacity,
    input_draining, least(input_started_at, v_now), v_now
  )
  on conflict (worker_id) do update
  set revision = excluded.revision,
      queues = excluded.queues,
      capacity = excluded.capacity,
      draining = excluded.draining,
      started_at = least(public.job_worker_heartbeats.started_at, excluded.started_at),
      heartbeat_at = excluded.heartbeat_at;

  delete from public.job_worker_heartbeats
  where heartbeat_at < v_now - interval '7 days';

  return jsonb_build_object(
    'accepted', true,
    'heartbeatAt', v_now,
    'draining', input_draining
  );
end;
$$;

revoke all on function public.heartbeat_job_worker(text,text,text[],integer,timestamptz,boolean)
  from public, anon, authenticated;
grant execute on function public.heartbeat_job_worker(text,text,text[],integer,timestamptz,boolean)
  to service_role;

create or replace function public.mark_job_worker_draining(
  input_worker_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := clock_timestamp();
begin
  if input_worker_id is null or length(input_worker_id) not between 1 and 256
     or input_worker_id ~ '[[:cntrl:]]' then
    raise exception 'invalid_job_worker_identity' using errcode = '22023';
  end if;
  update public.job_worker_heartbeats
  set draining = true, heartbeat_at = v_now
  where worker_id = input_worker_id;
  return jsonb_build_object('accepted', found, 'heartbeatAt', v_now, 'draining', true);
end;
$$;

revoke all on function public.mark_job_worker_draining(text)
  from public, anon, authenticated;
grant execute on function public.mark_job_worker_draining(text)
  to service_role;

create or replace function public.read_job_worker_readiness_v1(
  input_required_queues text[] default array['chat','media','title','agent','outbox']::text[],
  input_max_age_seconds integer default 20
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
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
     or input_max_age_seconds is null or input_max_age_seconds not between 5 and 300 then
    raise exception 'invalid_job_worker_readiness' using errcode = '22023';
  end if;

  with active as (
    select queues, capacity
    from public.job_worker_heartbeats
    where not draining
      and heartbeat_at >= v_now - make_interval(secs => input_max_age_seconds)
  ), expanded as (
    select distinct queue_name
    from active cross join lateral unnest(active.queues) as queue_name
  )
  select
    coalesce(array_agg(queue_name order by queue_name), array[]::text[])
  into covered
  from expanded;

  select coalesce(array_agg(required_queue order by required_queue), array[]::text[])
  into missing
  from unnest(input_required_queues) as required_queue
  where not (required_queue = any(covered));

  select
    count(*) filter (
      where not draining
        and heartbeat_at >= v_now - make_interval(secs => input_max_age_seconds)
    ),
    coalesce(sum(capacity) filter (
      where not draining
        and heartbeat_at >= v_now - make_interval(secs => input_max_age_seconds)
    ), 0),
    count(*) filter (
      where not draining
        and heartbeat_at < v_now - make_interval(secs => input_max_age_seconds)
    ),
    count(*) filter (where draining),
    max(heartbeat_at) filter (where not draining),
    min(heartbeat_at) filter (
      where not draining
        and heartbeat_at >= v_now - make_interval(secs => input_max_age_seconds)
    )
  into active_workers, total_capacity, stale_workers, draining_workers,
    freshest_heartbeat_at, oldest_active_heartbeat_at
  from public.job_worker_heartbeats
  ;

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
    select
      count(*) as active_workers,
      coalesce(sum(worker.capacity), 0) as total_capacity,
      max(worker.heartbeat_at) as freshest_heartbeat_at
    from public.job_worker_heartbeats as worker
    where not worker.draining
      and worker.heartbeat_at >= v_now - make_interval(secs => input_max_age_seconds)
      and required_queue = any(worker.queues)
  ) as queue_state;

  return jsonb_build_object(
    'schemaVersion', 1,
    'generatedAt', v_now,
    'ready', cardinality(missing) = 0,
    'activeWorkers', active_workers,
    'totalCapacity', total_capacity,
    'staleWorkers', stale_workers,
    'drainingWorkers', draining_workers,
    'freshestHeartbeatAgeSeconds', case
      when freshest_heartbeat_at is null then null
      else greatest(0, extract(epoch from (v_now - freshest_heartbeat_at)))
    end,
    'oldestActiveHeartbeatAgeSeconds', case
      when oldest_active_heartbeat_at is null then null
      else greatest(0, extract(epoch from (v_now - oldest_active_heartbeat_at)))
    end,
    'requiredQueues', to_jsonb(input_required_queues),
    'coveredQueues', to_jsonb(covered),
    'missingQueues', to_jsonb(missing),
    'queues', queue_metrics
  );
end;
$$;

revoke all on function public.read_job_worker_readiness_v1(text[],integer)
  from public, anon, authenticated;
grant execute on function public.read_job_worker_readiness_v1(text[],integer)
  to service_role;

create or replace function public.runtime_healthcheck_v6()
returns boolean
language sql
stable
security definer
set search_path = public, auth, storage, pg_temp
as $$
  select public.runtime_healthcheck_v5()
    and to_regclass('public.job_worker_heartbeats') is not null
    and to_regprocedure(
      'public.heartbeat_job_worker(text,text,text[],integer,timestamptz,boolean)'
    ) is not null
    and to_regprocedure('public.read_job_worker_readiness_v1(text[],integer)') is not null
    and not has_table_privilege('authenticated', 'public.job_worker_heartbeats', 'SELECT')
    and has_function_privilege(
      'service_role',
      'public.heartbeat_job_worker(text,text,text[],integer,timestamptz,boolean)',
      'EXECUTE'
    )
    and has_function_privilege(
      'service_role', 'public.read_job_worker_readiness_v1(text[],integer)', 'EXECUTE'
    );
$$;

revoke all on function public.runtime_healthcheck_v6()
  from public, anon, authenticated;
grant execute on function public.runtime_healthcheck_v6()
  to service_role;

commit;
