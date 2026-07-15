-- A rollout is ready only when consumers from the same immutable revision cover
-- every queue. Heartbeats from the previous release remain observable but can
-- neither satisfy readiness nor inflate capacity for the current deployment.
begin;

create index if not exists job_worker_heartbeats_revision_state_idx
  on public.job_worker_heartbeats(revision, draining, heartbeat_at desc);

create or replace function public.read_job_worker_readiness_v2(
  input_required_queues text[],
  input_max_age_seconds integer,
  input_revision text
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
     or input_max_age_seconds is null or input_max_age_seconds not between 5 and 300
     or coalesce(input_revision, '') !~ '^(unknown|[0-9a-f]{7,64})$'
     or input_revision <> btrim(input_revision) then
    raise exception 'invalid_job_worker_readiness' using errcode = '22023';
  end if;

  with active as (
    select queues
    from public.job_worker_heartbeats
    where revision = input_revision
      and not draining
      and heartbeat_at >= v_now - make_interval(secs => input_max_age_seconds)
  ), expanded as (
    select distinct queue_name
    from active cross join lateral unnest(active.queues) as queue_name
  )
  select coalesce(array_agg(queue_name order by queue_name), array[]::text[])
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
  where revision = input_revision;

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
    where worker.revision = input_revision
      and not worker.draining
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

revoke all on function public.read_job_worker_readiness_v2(text[],integer,text)
  from public, anon, authenticated, service_role;
grant execute on function public.read_job_worker_readiness_v2(text[],integer,text)
  to service_role;

create or replace function public.runtime_healthcheck_v12()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.runtime_healthcheck_v11()
    and to_regclass('public.job_worker_heartbeats_revision_state_idx') is not null
    and to_regprocedure(
      'public.read_job_worker_readiness_v2(text[],integer,text)'
    ) is not null
    and exists (
      select 1
      from pg_proc as projector
      where projector.oid = to_regprocedure('public.project_job_terminal()')
        and projector.prorettype = 'trigger'::regtype
        and projector.prosecdef
    )
    and exists (
      select 1
      from pg_trigger as terminal_trigger
      where terminal_trigger.tgrelid = 'public.jobs'::regclass
        and terminal_trigger.tgname = 'jobs_project_terminal'
        and terminal_trigger.tgfoid = to_regprocedure('public.project_job_terminal()')
        and not terminal_trigger.tgisinternal
        and terminal_trigger.tgenabled in ('O', 'A')
    )
    and not exists (
      select 1
      from (values
        ('public.project_files'::regclass, 'project_files_tenant_project_fkey'),
        ('public.project_memories'::regclass, 'project_memories_tenant_project_fkey'),
        ('public.conversations'::regclass, 'conversations_tenant_project_fkey'),
        ('public.messages'::regclass, 'messages_tenant_conversation_fkey'),
        ('public.conversations'::regclass, 'conversations_tenant_summary_message_fkey'),
        ('public.code_messages'::regclass, 'code_messages_tenant_session_fkey'),
        ('public.conversation_chunks'::regclass, 'conversation_chunks_tenant_conversation_fkey'),
        ('public.conversation_chunks'::regclass, 'conversation_chunks_tenant_project_fkey'),
        ('public.conversation_chunks'::regclass, 'conversation_chunks_tenant_message_start_fkey'),
        ('public.conversation_chunks'::regclass, 'conversation_chunks_tenant_message_end_fkey'),
        ('public.artifacts'::regclass, 'artifacts_tenant_conversation_fkey'),
        ('public.artifacts'::regclass, 'artifacts_tenant_message_fkey'),
        ('public.artifacts'::regclass, 'artifacts_conversation_message_fkey'),
        ('public.artifacts'::regclass, 'artifacts_tenant_project_fkey'),
        ('public.chat_generations'::regclass, 'chat_generations_tenant_conversation_fkey'),
        ('public.chat_generations'::regclass, 'chat_generations_tenant_assistant_message_fkey'),
        ('public.messages'::regclass, 'messages_tenant_generation_fkey'),
        ('public.agent_task_steps'::regclass, 'agent_task_steps_tenant_task_fkey'),
        ('public.agent_tool_calls'::regclass, 'agent_tool_calls_tenant_task_fkey'),
        ('public.agent_tool_calls'::regclass, 'agent_tool_calls_tenant_task_step_fkey'),
        ('public.agent_workspaces'::regclass, 'agent_workspaces_tenant_task_fkey'),
        ('public.agent_artifacts'::regclass, 'agent_artifacts_tenant_task_fkey'),
        ('public.agent_confirmation_gates'::regclass, 'agent_confirmation_gates_tenant_task_fkey'),
        ('public.agent_workspace_heads'::regclass, 'agent_workspace_heads_tenant_task_fkey'),
        ('public.agent_workspace_heads'::regclass, 'agent_workspace_heads_tenant_job_fkey'),
        ('public.job_events'::regclass, 'job_events_tenant_job_fkey'),
        ('public.job_checkpoints'::regclass, 'job_checkpoints_tenant_job_fkey'),
        ('public.job_tool_effects'::regclass, 'job_tool_effects_tenant_job_fkey'),
        ('public.job_outbox'::regclass, 'job_outbox_job_principal_fkey'),
        ('public.job_assets'::regclass, 'job_assets_job_principal_fkey'),
        ('public.ledger_entries'::regclass, 'ledger_entries_tenant_job_fkey'),
        ('public.ledger_balance_settlements'::regclass, 'ledger_balance_settlements_tenant_entry_fkey'),
        ('public.audit_log'::regclass, 'audit_log_tenant_job_fkey'),
        ('public.job_admission_reservations'::regclass, 'job_admission_reservations_tenant_job_fkey'),
        ('public.jobs'::regclass, 'jobs_tenant_confirmation_fkey')
      ) as required_constraint(relation_id, constraint_name)
      where not exists (
        select 1
        from pg_constraint as installed_constraint
        where installed_constraint.conrelid = required_constraint.relation_id
          and installed_constraint.conname = required_constraint.constraint_name
          and installed_constraint.contype = 'f'
          and cardinality(installed_constraint.conkey) >= 2
          and installed_constraint.convalidated
      )
    )
    and has_function_privilege(
      'service_role',
      'public.read_job_worker_readiness_v2(text[],integer,text)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'public.read_job_worker_readiness_v2(text[],integer,text)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'public.read_job_worker_readiness_v2(text[],integer,text)',
      'EXECUTE'
    );
$$;

revoke all on function public.runtime_healthcheck_v12()
  from public, anon, authenticated, service_role;
grant execute on function public.runtime_healthcheck_v12() to service_role;

commit;
