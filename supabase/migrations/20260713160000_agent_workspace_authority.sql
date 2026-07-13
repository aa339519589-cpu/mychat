-- A task's current workspace is a DB pointer to an immutable CAS manifest.
-- Worker-local disks are caches only; every mutation advances this pointer
-- under the active job lease/fence.
begin;

create table if not exists public.agent_workspace_heads (
  task_id uuid primary key references public.agent_tasks(id) on delete cascade,
  user_id uuid not null,
  snapshot_id uuid not null,
  manifest_digest text not null check (manifest_digest ~ '^[0-9a-f]{64}$'),
  tree_digest text not null check (tree_digest ~ '^[0-9a-f]{64}$'),
  head text not null check (head ~ '^[0-9a-f]{40,64}$'),
  version bigint not null default 1 check (version > 0),
  job_id uuid not null references public.jobs(id) on delete restrict,
  lease_version bigint not null check (lease_version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, task_id),
  unique(user_id, task_id, snapshot_id, manifest_digest)
);

alter table public.agent_workspace_heads enable row level security;
drop policy if exists agent_workspace_heads_select_own on public.agent_workspace_heads;
create policy agent_workspace_heads_select_own on public.agent_workspace_heads
  for select to authenticated using (user_id = auth.uid());
revoke all on public.agent_workspace_heads from public, anon, authenticated;
grant select on public.agent_workspace_heads to authenticated, service_role;
grant insert, update, delete on public.agent_workspace_heads to service_role;

create or replace function public.advance_agent_workspace_head(
  input_job_id uuid,
  input_worker_id text,
  input_lease_version bigint,
  input_snapshot_id uuid,
  input_manifest_digest text,
  input_tree_digest text,
  input_head text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job public.jobs%rowtype;
  v_artifact public.agent_artifacts%rowtype;
  v_manifest jsonb;
  v_current public.agent_workspace_heads%rowtype;
  v_task_id uuid;
  v_now timestamptz := clock_timestamp();
begin
  if input_snapshot_id is null
     or coalesce(input_manifest_digest, '') !~ '^[0-9a-f]{64}$'
     or coalesce(input_tree_digest, '') !~ '^[0-9a-f]{64}$'
     or coalesce(input_head, '') !~ '^[0-9a-f]{40,64}$' then
    raise exception 'invalid_agent_workspace_head' using errcode = '22023';
  end if;
  select * into v_job from public.jobs where id = input_job_id for update;
  if not found or v_job.type <> 'agent.task'
     or v_job.status not in ('leased', 'running', 'cancelling')
     or v_job.lease_owner is distinct from input_worker_id
     or v_job.lease_version is distinct from input_lease_version
     or v_job.lease_expires_at is null or v_job.lease_expires_at <= v_now then
    return jsonb_build_object('ok', false, 'reason', 'stale_fence');
  end if;
  v_task_id := (v_job.subject->>'taskId')::uuid;
  select * into v_artifact from public.agent_artifacts
  where task_id = v_task_id and user_id = v_job.principal_id
    and kind = 'summary' and title = 'snapshot:' || input_snapshot_id::text
  order by created_at desc limit 1;
  if not found then return jsonb_build_object('ok', false, 'reason', 'artifact_not_found'); end if;
  begin
    v_manifest := v_artifact.content::jsonb->'manifest';
  exception when others then
    return jsonb_build_object('ok', false, 'reason', 'invalid_manifest');
  end;
  if v_artifact.content::jsonb->>'format' <> 'cas-v1'
     or v_manifest->>'snapshotId' <> input_snapshot_id::text
     or v_manifest->>'taskId' <> v_task_id::text
     or v_manifest->>'userId' <> v_job.principal_id::text
     or v_manifest->>'manifestDigest' <> input_manifest_digest
     or v_manifest->>'treeDigest' <> input_tree_digest
     or v_manifest->>'head' <> input_head
     or v_manifest->>'reason' not like 'authority:%' then
    return jsonb_build_object('ok', false, 'reason', 'manifest_binding_mismatch');
  end if;
  select * into v_current from public.agent_workspace_heads
  where task_id = v_task_id for update;
  insert into public.agent_workspace_heads(
    task_id,user_id,snapshot_id,manifest_digest,tree_digest,head,
    version,job_id,lease_version,created_at,updated_at
  ) values (
    v_task_id,v_job.principal_id,input_snapshot_id,input_manifest_digest,input_tree_digest,input_head,
    coalesce(v_current.version, 0) + 1,v_job.id,input_lease_version,v_now,v_now
  ) on conflict (task_id) do update set
    user_id = excluded.user_id,
    snapshot_id = excluded.snapshot_id,
    manifest_digest = excluded.manifest_digest,
    tree_digest = excluded.tree_digest,
    head = excluded.head,
    version = public.agent_workspace_heads.version + 1,
    job_id = excluded.job_id,
    lease_version = excluded.lease_version,
    updated_at = excluded.updated_at;
  return jsonb_build_object(
    'ok', true, 'taskId', v_task_id, 'snapshotId', input_snapshot_id,
    'manifestDigest', input_manifest_digest, 'treeDigest', input_tree_digest,
    'head', input_head, 'version', coalesce(v_current.version, 0) + 1
  );
end;
$$;

revoke all on function public.advance_agent_workspace_head(uuid,text,bigint,uuid,text,text,text)
  from public, anon, authenticated;
grant execute on function public.advance_agent_workspace_head(uuid,text,bigint,uuid,text,text,text)
  to service_role;

-- The worker-created branch is part of task authority too.  Bind it exactly
-- once under the same lease/fence before the first immutable snapshot becomes
-- current; a retry may repeat the same value but can never silently switch it.
create or replace function public.bind_agent_workspace_branch(
  input_job_id uuid,
  input_worker_id text,
  input_lease_version bigint,
  input_agent_branch text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job public.jobs%rowtype;
  v_task public.agent_tasks%rowtype;
  v_task_id uuid;
  v_now timestamptz := clock_timestamp();
begin
  if input_agent_branch is null
     or length(input_agent_branch) > 240
     or input_agent_branch !~ '^[A-Za-z0-9][A-Za-z0-9._/-]*$'
     or input_agent_branch like '%..%'
     or input_agent_branch like '%//%'
     or input_agent_branch like '%/.%'
     or input_agent_branch like '%.lock' then
    raise exception 'invalid_agent_workspace_branch' using errcode = '22023';
  end if;
  select * into v_job from public.jobs where id = input_job_id for update;
  if not found or v_job.type <> 'agent.task'
     or v_job.status not in ('leased', 'running', 'cancelling')
     or v_job.lease_owner is distinct from input_worker_id
     or v_job.lease_version is distinct from input_lease_version
     or v_job.lease_expires_at is null or v_job.lease_expires_at <= v_now then
    return jsonb_build_object('ok', false, 'reason', 'stale_fence');
  end if;
  v_task_id := (v_job.subject->>'taskId')::uuid;
  select * into v_task from public.agent_tasks
  where id = v_task_id and user_id = v_job.principal_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'task_not_found'); end if;
  if v_task.agent_branch is not null and v_task.agent_branch <> input_agent_branch then
    return jsonb_build_object('ok', false, 'reason', 'branch_conflict',
      'agentBranch', v_task.agent_branch);
  end if;
  update public.agent_tasks set
    agent_branch = input_agent_branch,
    updated_at = v_now
  where id = v_task_id;
  return jsonb_build_object('ok', true, 'taskId', v_task_id,
    'agentBranch', input_agent_branch);
end;
$$;

revoke all on function public.bind_agent_workspace_branch(uuid,text,bigint,text)
  from public, anon, authenticated;
grant execute on function public.bind_agent_workspace_branch(uuid,text,bigint,text)
  to service_role;

-- Agent editing and publish are one serial stream for a task.
drop index if exists public.jobs_one_active_agent_task_idx;
drop index if exists public.jobs_one_active_agent_operation_task_idx;
create unique index if not exists jobs_one_active_agent_subject_idx
  on public.jobs(principal_id, ((subject->>'taskId')))
  where type in ('agent.task', 'agent.operation')
    and status in ('queued', 'leased', 'running', 'awaiting_input', 'cancelling');

create or replace function public.enforce_agent_operation_current_head()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job public.jobs%rowtype;
  v_head public.agent_workspace_heads%rowtype;
begin
  select * into v_job from public.jobs where id = new.id;
  if not found or v_job.type <> 'agent.operation'
     or v_job.payload->>'kind' <> 'workspace_publish' then return null; end if;
  select * into v_head from public.agent_workspace_heads
  where task_id = (v_job.subject->>'taskId')::uuid
    and user_id = v_job.principal_id;
  if not found
     or v_head.snapshot_id::text <> v_job.authority_snapshot_id
     or v_head.manifest_digest <> v_job.authority_snapshot_digest
     or v_head.head <> v_job.payload->'snapshot'->>'head' then
    raise exception 'agent_operation_not_current_workspace_head' using errcode = '23514';
  end if;
  return null;
end;
$$;

drop trigger if exists jobs_agent_operation_current_head_deferred on public.jobs;
create constraint trigger jobs_agent_operation_current_head_deferred
after insert or update of type,authority_snapshot_id,authority_snapshot_digest,payload
on public.jobs deferrable initially deferred
for each row execute function public.enforce_agent_operation_current_head();

revoke all on function public.enforce_agent_operation_current_head()
  from public, anon, authenticated;

commit;
