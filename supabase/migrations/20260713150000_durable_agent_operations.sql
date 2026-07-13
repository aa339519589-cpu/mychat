-- Atomically bind a single-use high-risk confirmation to a durable Agent
-- operation. HTTP callers can only create/confirm/enqueue; every GitHub or
-- filesystem side effect is executed later by a fenced worker.
begin;

alter table public.jobs
  add column if not exists confirmation_id uuid references public.agent_confirmation_gates(id) on delete restrict,
  add column if not exists confirmation_plan_hash bytea,
  add column if not exists authority_snapshot_id text,
  add column if not exists authority_snapshot_digest text;

alter table public.jobs drop constraint if exists jobs_agent_operation_authority_check;
alter table public.jobs add constraint jobs_agent_operation_authority_check check (
  type = 'agent.operation'
  or (confirmation_id is null and confirmation_plan_hash is null
    and authority_snapshot_id is null and authority_snapshot_digest is null)
);

create or replace function public.enforce_agent_operation_authority()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job public.jobs%rowtype;
begin
  select * into v_job from public.jobs where id = new.id;
  if not found or v_job.type <> 'agent.operation' then return null; end if;
  if v_job.confirmation_id is null or octet_length(v_job.confirmation_plan_hash) <> 32
     or not (
       (v_job.payload->>'kind' = 'initial_repository'
         and v_job.authority_snapshot_id is null and v_job.authority_snapshot_digest is null)
       or
       (v_job.payload->>'kind' = 'workspace_publish'
         and length(v_job.authority_snapshot_id) between 1 and 200
         and v_job.authority_snapshot_digest ~ '^[0-9a-f]{64}$')
     ) then
    raise exception 'agent_operation_authority_unbound' using errcode = '23514';
  end if;
  return null;
end;
$$;

drop trigger if exists jobs_agent_operation_authority_deferred on public.jobs;
create constraint trigger jobs_agent_operation_authority_deferred
after insert or update of type,confirmation_id,confirmation_plan_hash,authority_snapshot_id,authority_snapshot_digest
on public.jobs deferrable initially deferred
for each row execute function public.enforce_agent_operation_authority();

revoke all on function public.enforce_agent_operation_authority()
  from public, anon, authenticated;

create unique index if not exists jobs_confirmation_id_idx
  on public.jobs(confirmation_id) where confirmation_id is not null;
create unique index if not exists jobs_one_active_agent_operation_task_idx
  on public.jobs(principal_id, ((subject->>'taskId')))
  where type = 'agent.operation'
    and status in ('queued', 'leased', 'running', 'awaiting_input', 'cancelling');

comment on column public.jobs.confirmation_id is
  'Permanent binding from an agent.operation job to its single-use confirmation.';
comment on column public.jobs.confirmation_plan_hash is
  'SHA-256 of the exact canonical high-risk plan consumed atomically with enqueue.';
comment on column public.jobs.authority_snapshot_digest is
  'Immutable DB-authoritative CAS manifest digest restored and reverified by the worker.';

create or replace function public.create_agent_operation_confirmation(
  input_user_id uuid,
  input_task_id uuid,
  input_goal text,
  input_plan_canonical text,
  input_token_sha256 text,
  input_title text,
  input_reason text,
  input_files text[] default '{}'::text[]
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_task public.agent_tasks%rowtype;
  v_now timestamptz := clock_timestamp();
  v_plan jsonb;
begin
  perform public.assert_agent_confirmation_actor(input_user_id);
  if input_task_id is null or length(coalesce(input_goal, '')) not between 1 and 10000
     or length(coalesce(input_plan_canonical, '')) not between 2 and 131072
     or coalesce(input_token_sha256, '') !~ '^[0-9a-f]{64}$'
     or length(coalesce(input_title, '')) not between 1 and 500
     or length(coalesce(input_reason, '')) not between 1 and 4000
     or cardinality(coalesce(input_files, '{}'::text[])) > 100 then
    raise exception 'invalid_agent_operation_confirmation' using errcode = '22023';
  end if;
  begin
    v_plan := input_plan_canonical::jsonb;
  exception when others then
    raise exception 'invalid_agent_operation_plan' using errcode = '22023';
  end;
  if v_plan->>'version' <> '1'
     or v_plan->>'userId' is distinct from input_user_id::text
     or v_plan->>'taskId' is distinct from input_task_id::text
     or v_plan->>'operation' <> 'publish'
     or v_plan->>'repo' is not null
     or v_plan->>'baseBranch' <> 'main'
     or v_plan->>'workspaceBranch' is not null
     or v_plan->>'head' is not null
     or v_plan->'payload'->>'kind' <> 'initial_repository' then
    raise exception 'invalid_initial_operation_plan' using errcode = '22023';
  end if;

  insert into public.agent_tasks(
    id, user_id, goal, mode, repo, branch, status, meta, created_at, updated_at
  ) values (
    input_task_id, input_user_id, input_goal, 'auto', null, 'main', 'queued',
    jsonb_build_object('authority', 'agent.operation'), v_now, v_now
  ) on conflict (id) do nothing;

  select * into v_task from public.agent_tasks
  where id = input_task_id and user_id = input_user_id for update;
  if not found or v_task.repo is not null then
    raise exception 'agent_operation_task_conflict' using errcode = '23505';
  end if;
  return public.create_agent_confirmation_gate(
    input_user_id => input_user_id,
    input_task_id => input_task_id,
    input_operation => 'publish',
    input_risk_level => 'high',
    input_title => input_title,
    input_reason => input_reason,
    input_files => coalesce(input_files, '{}'::text[]),
    input_plan_canonical => input_plan_canonical,
    input_token_sha256 => input_token_sha256,
    input_resume_status => 'queued',
    input_ttl_seconds => 600
  );
end;
$$;

revoke all on function public.create_agent_operation_confirmation(
  uuid,uuid,text,text,text,text,text,text[]
)
  from public, anon;
grant execute on function public.create_agent_operation_confirmation(
  uuid,uuid,text,text,text,text,text,text[]
)
  to authenticated, service_role;

create or replace function public.enqueue_agent_operation(
  input_user_id uuid,
  input_task_id uuid,
  input_confirmation_id uuid,
  input_operation text,
  input_plan_canonical text,
  input_token_sha256 text,
  input_job_id uuid,
  input_auth_class text,
  input_idempotency_key text,
  input_input_hash text,
  input_payload jsonb,
  input_snapshot_id text default null,
  input_snapshot_digest text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, storage, pg_temp
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_gate public.agent_confirmation_gates%rowtype;
  v_task public.agent_tasks%rowtype;
  v_existing public.jobs%rowtype;
  v_job public.jobs%rowtype;
  v_plan jsonb;
  v_result jsonb;
  v_plan_hash bytea;
  v_kind text;
begin
  perform public.assert_agent_confirmation_actor(input_user_id);
  if input_task_id is null or input_confirmation_id is null or input_job_id is null
     or input_operation <> 'publish'
     or input_auth_class not in ('anonymous', 'registered')
     or length(coalesce(input_plan_canonical, '')) not between 2 and 131072
     or coalesce(input_token_sha256, '') !~ '^[0-9a-f]{64}$'
     or length(coalesce(input_idempotency_key, '')) not between 1 and 256
     or length(coalesce(input_input_hash, '')) not between 16 and 256
     or jsonb_typeof(input_payload) <> 'object'
     or octet_length(input_payload::text) > 1048576 then
    raise exception 'invalid_agent_operation_enqueue' using errcode = '22023';
  end if;
  if input_payload ?| array[
    'token', 'secret', 'credential', 'confirmationToken', 'githubToken',
    'accessToken', 'apiKey'
  ] then
    raise exception 'agent_operation_secret_in_payload' using errcode = '22023';
  end if;
  begin
    v_plan := input_plan_canonical::jsonb;
  exception when others then
    raise exception 'invalid_agent_operation_plan' using errcode = '22023';
  end;
  v_plan_hash := digest(convert_to(input_plan_canonical, 'UTF8'), 'sha256');
  v_kind := input_payload->>'kind';
  if v_plan->>'version' <> '1'
     or v_plan->>'userId' is distinct from input_user_id::text
     or v_plan->>'taskId' is distinct from input_task_id::text
     or v_plan->>'operation' <> 'publish'
     or v_plan->'payload'->>'kind' is distinct from v_kind
     or coalesce(v_plan->'payload'->>'operationInputSha256', '') !~ '^[0-9a-f]{64}$'
     or v_plan->'payload'->>'operationInputSha256' is distinct from input_payload->>'operationHash'
     or encode(v_plan_hash, 'hex') is distinct from input_payload->>'planHash'
     or input_payload->>'taskId' is distinct from input_task_id::text
     or input_payload->>'schemaVersion' <> '1'
     or v_kind not in ('initial_repository', 'workspace_publish') then
    raise exception 'agent_operation_plan_binding_mismatch' using errcode = '22023';
  end if;

  select * into v_existing from public.jobs
  where confirmation_id = input_confirmation_id for update;
  if found then
    if v_existing.principal_id is distinct from input_user_id
       or v_existing.type <> 'agent.operation'
       or v_existing.input_hash is distinct from input_input_hash
       or v_existing.confirmation_plan_hash is distinct from v_plan_hash then
      raise exception 'agent_operation_confirmation_replay_conflict' using errcode = '23505';
    end if;
    return jsonb_build_object(
      'enqueued', false, 'replayed', true, 'job', public.job_contract_json(v_existing)
    );
  end if;

  select * into v_task from public.agent_tasks
  where id = input_task_id and user_id = input_user_id for update;
  if not found then
    raise exception 'agent_operation_task_not_found' using errcode = '23503';
  end if;

  if v_kind = 'initial_repository' then
    if v_task.repo is not null or v_plan->'repo' <> 'null'::jsonb
       or input_snapshot_id is not null or input_snapshot_digest is not null
       or input_payload->'snapshot' <> 'null'::jsonb
       or jsonb_typeof(input_payload->'actions') <> 'array'
       or jsonb_array_length(input_payload->'actions') < 1 then
      raise exception 'invalid_initial_repository_authority' using errcode = '22023';
    end if;
  else
    if v_task.repo is null
       or input_payload->>'targetRepo' is distinct from v_task.repo
       or v_plan->>'repo' is distinct from v_task.repo
       or coalesce(input_snapshot_id, '') = ''
       or coalesce(input_snapshot_digest, '') !~ '^[0-9a-f]{64}$'
       or v_plan->>'head' is distinct from input_payload->'snapshot'->>'head'
       or v_plan->>'workspaceStateSha256' is distinct from input_snapshot_digest
       or input_payload->'snapshot'->>'snapshotId' is distinct from input_snapshot_id
       or input_payload->'snapshot'->>'manifestDigest' is distinct from input_snapshot_digest
       or not exists (
         select 1 from public.agent_artifacts artifact
         where artifact.task_id = input_task_id and artifact.user_id = input_user_id
           and artifact.kind = 'summary' and artifact.title = 'snapshot:' || input_snapshot_id
           and coalesce(artifact.content, '{}')::jsonb->>'format' = 'cas-v1'
           and coalesce(artifact.content, '{}')::jsonb->'manifest'->>'manifestDigest' = input_snapshot_digest
           and coalesce(artifact.content, '{}')::jsonb->'manifest'->>'head' = v_plan->>'head'
       ) then
      raise exception 'workspace_snapshot_authority_mismatch' using errcode = '22023';
    end if;
  end if;

  select * into v_gate from public.agent_confirmation_gates
  where id = input_confirmation_id and task_id = input_task_id and user_id = input_user_id
  for update;
  if not found or v_gate.operation <> input_operation
     or v_gate.token_hash is distinct from decode(input_token_sha256, 'hex') then
    return jsonb_build_object('enqueued', false, 'replayed', false, 'reason', 'invalid_confirmation');
  end if;
  if v_gate.expires_at <= v_now then
    if v_gate.status in ('pending', 'approved') then
      update public.agent_confirmation_gates set status = 'expired', updated_at = v_now
      where id = v_gate.id;
    end if;
    return jsonb_build_object('enqueued', false, 'replayed', false, 'reason', 'expired');
  end if;
  if v_gate.status = 'consumed' then
    return jsonb_build_object('enqueued', false, 'replayed', false, 'reason', 'already_consumed');
  end if;
  if v_gate.status <> 'approved' then
    return jsonb_build_object('enqueued', false, 'replayed', false, 'reason', 'not_approved');
  end if;
  if v_gate.plan_hash is distinct from v_plan_hash
     or v_gate.plan_canonical is distinct from input_plan_canonical then
    return jsonb_build_object('enqueued', false, 'replayed', false, 'reason', 'plan_mismatch');
  end if;

  v_result := public.enqueue_job(
    input_job_id => input_job_id,
    input_type => 'agent.operation',
    input_queue => 'agent',
    input_principal_id => input_user_id,
    input_auth_class => input_auth_class,
    input_subject => jsonb_build_object(
      'taskId', input_task_id, 'operation', v_kind, 'confirmationId', input_confirmation_id
    ),
    input_idempotency_key => input_idempotency_key,
    input_input_hash => input_input_hash,
    input_payload => input_payload,
    input_budget => jsonb_build_object(
      'wallTimeMs', 2700000, 'sandboxTimeMs', 2400000, 'toolCallLimit', 32
    ),
    input_priority => 50,
    input_max_attempts => 3,
    input_available_at => v_now
  );
  select * into v_job from public.jobs
  where id = (v_result->'job'->>'id')::uuid for update;
  if not found or v_job.type <> 'agent.operation' or v_job.confirmation_id is not null then
    raise exception 'agent_operation_job_binding_failed' using errcode = '40001';
  end if;
  update public.jobs set
    confirmation_id = v_gate.id,
    confirmation_plan_hash = v_gate.plan_hash,
    authority_snapshot_id = input_snapshot_id,
    authority_snapshot_digest = input_snapshot_digest,
    updated_at = v_now
  where id = v_job.id returning * into v_job;
  update public.agent_confirmation_gates set
    status = 'consumed', consumed_at = v_now, updated_at = v_now
  where id = v_gate.id and status = 'approved';
  if not found then
    raise exception 'agent_operation_confirmation_consume_race' using errcode = '40001';
  end if;
  update public.agent_tasks set status = 'queued', error = null, updated_at = v_now
  where id = input_task_id and user_id = input_user_id;
  insert into public.audit_log(
    principal_id, actor_type, actor_id, action, resource_type, resource_id,
    job_id, metadata, created_at
  ) values (
    input_user_id, 'user', input_user_id::text, 'agent.operation.confirmed_enqueued',
    'agent_confirmation', v_gate.id::text, v_job.id,
    jsonb_build_object(
      'planHash', encode(v_gate.plan_hash, 'hex'), 'operation', v_kind,
      'snapshotId', input_snapshot_id
    ), v_now
  );
  return jsonb_build_object(
    'enqueued', true, 'replayed', false, 'job', public.job_contract_json(v_job)
  );
end;
$$;

revoke all on function public.enqueue_agent_operation(
  uuid,uuid,uuid,text,text,text,uuid,text,text,text,jsonb,text,text
) from public, anon;
grant execute on function public.enqueue_agent_operation(
  uuid,uuid,uuid,text,text,text,uuid,text,text,text,jsonb,text,text
) to authenticated, service_role;

create or replace function public.read_agent_operation_authority(
  input_job_id uuid,
  input_worker_id text,
  input_lease_version bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job public.jobs%rowtype;
  v_gate public.agent_confirmation_gates%rowtype;
begin
  select * into v_job from public.jobs where id = input_job_id for update;
  if not found or v_job.type <> 'agent.operation'
     or v_job.status not in ('leased', 'running', 'cancelling')
     or v_job.lease_owner is distinct from input_worker_id
     or v_job.lease_version is distinct from input_lease_version
     or v_job.lease_expires_at is null or v_job.lease_expires_at <= clock_timestamp() then
    return jsonb_build_object('ok', false, 'reason', 'stale_fence');
  end if;
  select * into v_gate from public.agent_confirmation_gates
  where id = v_job.confirmation_id and status = 'consumed';
  if not found or v_gate.plan_hash is distinct from v_job.confirmation_plan_hash then
    return jsonb_build_object('ok', false, 'reason', 'authority_mismatch');
  end if;
  return jsonb_build_object(
    'ok', true,
    'confirmationId', v_gate.id,
    'planCanonical', v_gate.plan_canonical,
    'planHash', encode(v_gate.plan_hash, 'hex'),
    'snapshotId', v_job.authority_snapshot_id,
    'snapshotDigest', v_job.authority_snapshot_digest
  );
end;
$$;

revoke all on function public.read_agent_operation_authority(uuid,text,bigint)
  from public, anon, authenticated;
grant execute on function public.read_agent_operation_authority(uuid,text,bigint)
  to service_role;

create or replace function public.bind_agent_operation_repository(
  input_job_id uuid,
  input_worker_id text,
  input_lease_version bigint,
  input_repo text,
  input_branch text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job public.jobs%rowtype;
  v_task public.agent_tasks%rowtype;
begin
  if coalesce(input_repo, '') !~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'
     or length(coalesce(input_branch, '')) not between 1 and 200 then
    raise exception 'invalid_agent_repository_binding' using errcode = '22023';
  end if;
  select * into v_job from public.jobs where id = input_job_id for update;
  if not found or v_job.type <> 'agent.operation'
     or v_job.payload->>'kind' <> 'initial_repository'
     or v_job.status not in ('leased', 'running', 'cancelling')
     or v_job.lease_owner is distinct from input_worker_id
     or v_job.lease_version is distinct from input_lease_version
     or v_job.lease_expires_at is null or v_job.lease_expires_at <= clock_timestamp() then
    return jsonb_build_object('ok', false, 'reason', 'stale_fence');
  end if;
  select * into v_task from public.agent_tasks
  where id = (v_job.subject->>'taskId')::uuid
    and user_id = v_job.principal_id for update;
  if not found or (v_task.repo is not null and v_task.repo <> input_repo) then
    return jsonb_build_object('ok', false, 'reason', 'task_conflict');
  end if;
  update public.agent_tasks set
    repo = input_repo,
    branch = input_branch,
    status = 'running',
    error = null,
    updated_at = clock_timestamp()
  where id = v_task.id and user_id = v_task.user_id;
  return jsonb_build_object('ok', true, 'repo', input_repo, 'branch', input_branch);
end;
$$;

revoke all on function public.bind_agent_operation_repository(uuid,text,bigint,text,text)
  from public, anon, authenticated;
grant execute on function public.bind_agent_operation_repository(uuid,text,bigint,text,text)
  to service_role;

create or replace function public.project_agent_operation_terminal()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.type <> 'agent.operation'
     or new.status not in ('completed', 'failed', 'cancelled')
     or old.status in ('completed', 'failed', 'cancelled') then
    return new;
  end if;
  update public.agent_tasks set
    status = new.status,
    error = case when new.status = 'failed' then new.error_code else null end,
    commit_sha = coalesce(new.result->>'commitSha', commit_sha),
    agent_branch = coalesce(new.result->>'branch', agent_branch),
    pull_request_url = coalesce(new.result->>'pullRequestUrl', pull_request_url),
    pull_request_number = coalesce((new.result->>'pullRequestNumber')::integer, pull_request_number),
    meta = coalesce(meta, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object(
      'agentOperationJobId', new.id,
      'pagesUrl', new.result->>'pagesUrl',
      'pagesStatus', new.result->>'pagesStatus',
      'mergeCommitSha', new.result->>'mergeCommitSha'
    )),
    finished_at = clock_timestamp(),
    updated_at = clock_timestamp()
  where id = (new.subject->>'taskId')::uuid and user_id = new.principal_id;
  return new;
end;
$$;

drop trigger if exists jobs_project_agent_operation_terminal on public.jobs;
create trigger jobs_project_agent_operation_terminal
after update of status on public.jobs
for each row execute function public.project_agent_operation_terminal();

commit;
