-- Cross-process, database-authoritative operational metrics for the durable
-- job control plane. The RPC intentionally returns only closed-set labels and
-- aggregate numbers: no principal, job, request, provider, or object ids.
begin;

create index if not exists jobs_terminal_observability_idx
  on public.jobs(terminal_at, type)
  where terminal_at is not null;
create index if not exists jobs_cancel_observability_idx
  on public.jobs(cancel_requested_at, type)
  where cancel_requested_at is not null;
create index if not exists jobs_created_observability_idx
  on public.jobs(created_at, type);
create index if not exists job_outbox_status_observability_idx
  on public.job_outbox(status, available_at, created_at);

create or replace function public.job_observability_type(
  input_type text,
  input_queue text,
  input_payload jsonb
)
returns text
language sql
immutable
parallel safe
set search_path = public, pg_temp
as $$
  select case
    when input_type = 'chat.generation'
      and coalesce(input_payload->>'outputKind', 'text') = 'image' then 'media_image'
    when input_type = 'chat.generation'
      and coalesce(input_payload->>'outputKind', 'text') = 'video' then 'media_video'
    when input_type = 'chat.generation' then 'chat_generation'
    when input_type = 'agent.task' then 'agent_task'
    when input_type = 'chat.title' then 'title'
    when input_type like 'tool.%' or input_queue = 'tool' then 'tool'
    when input_type like 'cleanup.%' or input_queue = 'cleanup' then 'cleanup'
    else 'other'
  end
$$;

revoke all on function public.job_observability_type(text,text,jsonb)
  from public, anon, authenticated, service_role;

-- A tiny trigger-maintained rollup gives Prometheus a monotonic, durable
-- terminal counter without rescanning every historical job on each scrape.
create table if not exists public.job_observability_terminal_counts (
  job_type text not null check (job_type in (
    'chat_generation', 'media_image', 'media_video', 'agent_task',
    'tool', 'title', 'cleanup', 'other'
  )),
  status text not null check (status in ('completed', 'failed', 'cancelled')),
  total bigint not null default 0 check (total >= 0),
  updated_at timestamptz not null default now(),
  primary key (job_type, status)
);
alter table public.job_observability_terminal_counts enable row level security;
revoke all on table public.job_observability_terminal_counts
  from public, anon, authenticated, service_role;

create or replace function public.record_job_observability_terminal()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  should_record boolean := false;
begin
  if new.status in ('completed', 'failed', 'cancelled') then
    if tg_op = 'INSERT' then
      should_record := true;
    elsif tg_op = 'UPDATE' then
      should_record := old.status not in ('completed', 'failed', 'cancelled');
    end if;
  end if;
  if should_record then
    update public.job_observability_terminal_counts
    set total = total + 1, updated_at = clock_timestamp()
    where job_type = public.job_observability_type(new.type, new.queue, new.payload)
      and status = new.status;
    if not found then
      raise exception 'job_observability_rollup_missing' using errcode = '55000';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.record_job_observability_terminal()
  from public, anon, authenticated, service_role;

-- CREATE TRIGGER locks jobs until commit, so the exact historical backfill and
-- installation of the incremental path cannot lose a terminal transition.
drop trigger if exists record_job_observability_terminal on public.jobs;
create trigger record_job_observability_terminal
after insert or update of status on public.jobs
for each row execute function public.record_job_observability_terminal();

with
labels(job_type) as (
  values ('chat_generation'::text), ('media_image'::text), ('media_video'::text),
    ('agent_task'::text), ('tool'::text), ('title'::text), ('cleanup'::text),
    ('other'::text)
),
statuses(status) as (
  values ('completed'::text), ('failed'::text), ('cancelled'::text)
),
totals as (
  select public.job_observability_type(type, queue, payload) as job_type,
    status, count(*)::bigint as total
  from public.jobs
  where status in ('completed', 'failed', 'cancelled')
  group by 1, 2
)
insert into public.job_observability_terminal_counts(job_type, status, total, updated_at)
select labels.job_type, statuses.status, coalesce(totals.total, 0), clock_timestamp()
from labels cross join statuses
left join totals using (job_type, status)
on conflict (job_type, status) do update
set total = excluded.total, updated_at = excluded.updated_at;

create or replace function public.read_job_observability_v1(
  input_window_seconds integer default 3600
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
set statement_timeout = '8s'
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_window_start timestamptz;
  v_job_types jsonb;
  v_outbox jsonb;
  v_assets jsonb;
begin
  if input_window_seconds is null
     or input_window_seconds not between 300 and 86400 then
    raise exception 'invalid_observability_window' using errcode = '22023';
  end if;
  v_window_start := v_now - make_interval(secs => input_window_seconds);

  with
  labels(job_type, ordinal) as (
    values
      ('chat_generation'::text, 1),
      ('media_image'::text, 2),
      ('media_video'::text, 3),
      ('agent_task'::text, 4),
      ('tool'::text, 5),
      ('title'::text, 6),
      ('cleanup'::text, 7),
      ('other'::text, 8)
  ),
  queue_stats as (
    select
      public.job_observability_type(type, queue, payload) as job_type,
      count(*)::bigint as depth,
      greatest(0, extract(epoch from (v_now - min(created_at))))::double precision
        as oldest_age_seconds
    from public.jobs
    where status = 'queued'
    group by 1
  ),
  terminal_window_stats as (
    select
      public.job_observability_type(type, queue, payload) as job_type,
      count(*) filter (where status = 'completed')::bigint as completed,
      count(*) filter (where status = 'failed')::bigint as failed,
      count(*) filter (where status = 'cancelled')::bigint as cancelled
    from public.jobs
    where terminal_at >= v_window_start and terminal_at <= v_now
    group by 1
  ),
  terminal_total_stats as (
    select job_type,
      max(total) filter (where status = 'completed')::bigint as completed,
      max(total) filter (where status = 'failed')::bigint as failed,
      max(total) filter (where status = 'cancelled')::bigint as cancelled
    from public.job_observability_terminal_counts
    group by job_type
  ),
  health_stats as (
    select
      public.job_observability_type(type, queue, payload) as job_type,
      count(*) filter (
        where status in ('leased', 'running', 'cancelling')
          and lease_expires_at <= v_now
      )::bigint as lease_expired,
      count(*) filter (
        where status = 'queued' and attempt > 0
      )::bigint as retry_waiting,
      count(*) filter (
        where status = 'failed'
          and terminal_at >= v_window_start and terminal_at <= v_now
          and (
            attempt >= max_attempts
            or error_code in ('job_attempts_exhausted', 'stale_lease_unrecoverable')
          )
      )::bigint as poison
    from public.jobs
    where (
      status in ('queued', 'leased', 'running', 'cancelling')
      or (status = 'failed' and terminal_at >= v_window_start and terminal_at <= v_now)
    )
    group by 1
  ),
  enqueue_slo as (
    select
      public.job_observability_type(type, queue, payload) as job_type,
      count(*) filter (
        where started_at is not null or created_at <= v_now - interval '2 seconds'
      )::bigint as eligible,
      count(*) filter (
        where started_at >= created_at
          and started_at <= created_at + interval '2 seconds'
      )::bigint as good
    from public.jobs
    where created_at >= v_window_start and created_at <= v_now
    group by 1
  ),
  cancel_slo as (
    select
      public.job_observability_type(type, queue, payload) as job_type,
      count(*) filter (
        where terminal_at is not null
          or cancel_requested_at <= v_now - interval '3 seconds'
      )::bigint as eligible,
      count(*) filter (
        where terminal_at >= cancel_requested_at
          and terminal_at <= cancel_requested_at + interval '3 seconds'
      )::bigint as good
    from public.jobs
    where cancel_requested_at >= v_window_start and cancel_requested_at <= v_now
    group by 1
  )
  select jsonb_agg(
    jsonb_build_object(
      'jobType', labels.job_type,
      'queueDepth', coalesce(queue_stats.depth, 0),
      'queueOldestAgeSeconds', coalesce(queue_stats.oldest_age_seconds, 0),
      'terminal', jsonb_build_object(
        'completed', coalesce(terminal_window_stats.completed, 0),
        'failed', coalesce(terminal_window_stats.failed, 0),
        'cancelled', coalesce(terminal_window_stats.cancelled, 0)
      ),
      'terminalTotal', jsonb_build_object(
        'completed', coalesce(terminal_total_stats.completed, 0),
        'failed', coalesce(terminal_total_stats.failed, 0),
        'cancelled', coalesce(terminal_total_stats.cancelled, 0)
      ),
      'leaseExpired', coalesce(health_stats.lease_expired, 0),
      'retryWaiting', coalesce(health_stats.retry_waiting, 0),
      'poison', coalesce(health_stats.poison, 0),
      'enqueueStarted', jsonb_build_object(
        'good', coalesce(enqueue_slo.good, 0),
        'eligible', coalesce(enqueue_slo.eligible, 0),
        'ratio', case when coalesce(enqueue_slo.eligible, 0) = 0 then null
          else enqueue_slo.good::numeric / enqueue_slo.eligible end
      ),
      'cancelTerminal', jsonb_build_object(
        'good', coalesce(cancel_slo.good, 0),
        'eligible', coalesce(cancel_slo.eligible, 0),
        'ratio', case when coalesce(cancel_slo.eligible, 0) = 0 then null
          else cancel_slo.good::numeric / cancel_slo.eligible end
      )
    ) order by labels.ordinal
  ) into v_job_types
  from labels
  left join queue_stats using (job_type)
  left join terminal_window_stats using (job_type)
  left join terminal_total_stats using (job_type)
  left join health_stats using (job_type)
  left join enqueue_slo using (job_type)
  left join cancel_slo using (job_type);

  select jsonb_build_object(
    'pending', count(*) filter (
      where status in ('pending', 'failed', 'publishing')
    ),
    'ready', count(*) filter (
      where attempts < max_attempts and (
        (status in ('pending', 'failed') and available_at <= v_now)
        or (status = 'publishing' and lock_expires_at <= v_now)
      )
    ),
    'oldestReadyAgeSeconds', coalesce(greatest(0, extract(epoch from (
      v_now - min(created_at) filter (
        where attempts < max_attempts and (
          (status in ('pending', 'failed') and available_at <= v_now)
          or (status = 'publishing' and lock_expires_at <= v_now)
        )
      )
    ))), 0),
    'expiredLeases', count(*) filter (
      where status = 'publishing' and lock_expires_at <= v_now
    ),
    'retrying', count(*) filter (
      where status in ('pending', 'failed', 'publishing') and attempts > 0
    ),
    'dead', count(*) filter (where status = 'dead')
  ) into v_outbox
  from public.job_outbox;

  select jsonb_build_object(
    'cleanupPending', count(*) filter (
      where asset.state = 'deleting'
        or (
          asset.state in ('reserved', 'uploaded')
          and job.status in ('completed', 'failed', 'cancelled')
        )
    ),
    'cleanupDead', count(*) filter (
      where asset.state <> 'deleted'
        and exists (
        select 1 from public.job_outbox as dead_message
        where dead_message.job_id = asset.job_id
          and dead_message.topic = 'assets.cleanup'
          and dead_message.status = 'dead'
      )
    ),
    'cleanupOrphan', count(*) filter (
      where asset.state in ('reserved', 'uploaded', 'deleting')
        and asset.updated_at <= v_now - interval '15 minutes'
        and job.status in ('completed', 'failed', 'cancelled')
        and not exists (
          select 1 from public.job_outbox as active_cleanup
          where active_cleanup.job_id = asset.job_id
            and active_cleanup.topic = 'assets.cleanup'
            and active_cleanup.status in ('pending', 'failed', 'publishing')
        )
    )
  ) into v_assets
  from public.job_assets as asset
  join public.jobs as job on job.id = asset.job_id
    and job.principal_id = asset.principal_id;

  return jsonb_build_object(
    'schemaVersion', 1,
    'generatedAt', v_now,
    'windowSeconds', input_window_seconds,
    'jobTypes', coalesce(v_job_types, '[]'::jsonb),
    'outbox', coalesce(v_outbox, '{}'::jsonb),
    'assets', coalesce(v_assets, '{}'::jsonb)
  );
end;
$$;

revoke all on function public.read_job_observability_v1(integer)
  from public, anon, authenticated, service_role;
grant execute on function public.read_job_observability_v1(integer)
  to service_role;

commit;
