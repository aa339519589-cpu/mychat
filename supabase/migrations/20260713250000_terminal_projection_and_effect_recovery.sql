-- Make every job terminal transition project through one database-owned path,
-- and permit a declared replay-safe tool effect to start a new execution only
-- after its previous execution durably failed.
begin;

create or replace function public.project_job_terminal()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  projected_status text;
  projected_rows integer;
  v_now timestamptz := coalesce(new.terminal_at, clock_timestamp());
begin
  if new.status not in ('completed', 'failed', 'cancelled')
     or old.status in ('completed', 'failed', 'cancelled')
     or new.type not in ('agent.task', 'agent.operation') then
    return new;
  end if;

  if coalesce(new.subject->>'taskId', '')
       !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' then
    raise exception 'agent_terminal_projection_task_invalid' using errcode = '23503';
  end if;

  projected_status := case
    when new.type = 'agent.task'
         and new.status = 'completed'
         and new.result->>'taskStatus' in ('waiting_for_user', 'completed')
      then new.result->>'taskStatus'
    else new.status
  end;

  if new.type = 'agent.operation' then
    update public.agent_tasks
    set status = projected_status,
        error = case when new.status = 'failed' then new.error_code else null end,
        commit_sha = coalesce(new.result->>'commitSha', commit_sha),
        agent_branch = coalesce(new.result->>'branch', agent_branch),
        pull_request_url = coalesce(new.result->>'pullRequestUrl', pull_request_url),
        pull_request_number = coalesce(
          case
            when coalesce(new.result->>'pullRequestNumber', '') ~ '^[0-9]{1,9}$'
              then (new.result->>'pullRequestNumber')::integer
            else null
          end,
          pull_request_number
        ),
        meta = coalesce(meta, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object(
          'agentOperationJobId', new.id,
          'pagesUrl', new.result->>'pagesUrl',
          'pagesStatus', new.result->>'pagesStatus',
          'mergeCommitSha', new.result->>'mergeCommitSha'
        )),
        finished_at = v_now,
        updated_at = v_now
    where id = (new.subject->>'taskId')::uuid
      and user_id = new.principal_id;
  else
    update public.agent_tasks
    set status = projected_status,
        error = new.error_code,
        finished_at = case when projected_status = 'waiting_for_user' then null else v_now end,
        updated_at = v_now
    where id = (new.subject->>'taskId')::uuid
      and user_id = new.principal_id;
  end if;
  get diagnostics projected_rows = row_count;
  if projected_rows <> 1 then
    raise exception 'agent_terminal_task_projection_missing' using errcode = '23503';
  end if;

  if new.type = 'agent.task' then
    if coalesce(new.subject->>'sessionId', '')
         !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
       or coalesce(new.subject->>'responseId', '')
         !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' then
      raise exception 'agent_terminal_message_identity_invalid' using errcode = '23503';
    end if;
    update public.code_messages
    set content = case
          when length(coalesce(new.result->>'content', '')) > 0
            then new.result->>'content'
          when new.status = 'cancelled' and content = '' then '已停止。'
          when new.status = 'failed' and content = ''
            then '任务执行失败，请稍后重试。'
          else content
        end,
        meta = coalesce(meta, '{}'::jsonb) || jsonb_build_object(
          'taskId', new.subject->>'taskId',
          'jobId', new.id,
          'status', projected_status,
          'errorCode', new.error_code,
          'progress', coalesce(new.result->'progress', '{}'::jsonb)
        )
    where id = (new.subject->>'responseId')::uuid
      and session_id = (new.subject->>'sessionId')::uuid
      and user_id = new.principal_id
      and role = 'assistant';
    get diagnostics projected_rows = row_count;
    if projected_rows <> 1 then
      raise exception 'agent_terminal_message_projection_missing' using errcode = '23503';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists jobs_project_agent_operation_terminal on public.jobs;
drop trigger if exists jobs_project_terminal on public.jobs;
create trigger jobs_project_terminal
after update of status on public.jobs
for each row execute function public.project_job_terminal();

revoke all on function public.project_job_terminal()
  from public, anon, authenticated, service_role;
revoke all on function public.project_agent_operation_terminal()
  from public, anon, authenticated, service_role;

create or replace function public.record_job_tool_effect(
  input_job_id uuid,
  input_worker_id text,
  input_lease_version bigint,
  input_tool_call_id text,
  input_tool_name text,
  input_args_hash text,
  input_effect_key text,
  input_status text,
  input_result_ref jsonb default null,
  input_replay_safe boolean default false,
  input_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_job public.jobs%rowtype;
  current_effect public.job_tool_effects%rowtype;
  v_now timestamptz := clock_timestamp();
  normalized_metadata jsonb := coalesce(input_metadata, '{}'::jsonb);
  retrying_failed_effect boolean := false;
begin
  if input_job_id is null or input_worker_id is null
     or length(input_worker_id) not between 1 and 256
     or input_lease_version is null or input_lease_version < 1
     or input_tool_call_id is null or length(input_tool_call_id) not between 1 and 200
     or input_tool_name is null or length(input_tool_name) not between 1 and 200
     or input_args_hash is null or length(input_args_hash) not between 16 and 200
     or input_effect_key is null or length(input_effect_key) not between 1 and 300
     or input_status not in (
       'reserved', 'running', 'succeeded', 'failed', 'compensated', 'unknown'
     )
     or jsonb_typeof(normalized_metadata) <> 'object'
     or octet_length(normalized_metadata::text) > 262144
     or (input_result_ref is not null and octet_length(input_result_ref::text) > 262144) then
    raise exception 'invalid_job_tool_effect' using errcode = '22023';
  end if;

  select * into current_job from public.jobs
  where id = input_job_id
  for update;
  if not found
     or current_job.status in ('completed', 'failed', 'cancelled')
     or current_job.lease_owner is distinct from input_worker_id
     or current_job.lease_version <> input_lease_version
     or current_job.lease_expires_at is null
     or current_job.lease_expires_at <= v_now then
    return jsonb_build_object(
      'recorded', false, 'replayed', false, 'reason', 'stale_fence',
      'effectId', null, 'status', null
    );
  end if;
  if current_job.cancel_requested_at is not null
     and input_status in ('reserved', 'running') then
    return jsonb_build_object(
      'recorded', false, 'replayed', false, 'reason', 'cancel_requested',
      'effectId', null, 'status', null
    );
  end if;

  select * into current_effect
  from public.job_tool_effects
  where principal_id = current_job.principal_id and effect_key = input_effect_key
  for update;
  if found then
    if current_effect.job_id <> current_job.id
       or current_effect.tool_call_id <> input_tool_call_id
       or current_effect.tool_name <> input_tool_name
       or current_effect.args_hash <> input_args_hash then
      raise exception 'tool_effect_idempotency_conflict' using errcode = '23505';
    end if;
    if current_effect.status in ('succeeded', 'compensated') then
      return jsonb_build_object(
        'recorded', false, 'replayed', true, 'reason', 'terminal_effect',
        'effectId', current_effect.id, 'status', current_effect.status,
        'resultRef', current_effect.result_ref
      );
    end if;

    retrying_failed_effect := current_effect.status = 'failed'
      and input_status = 'reserved';
    if retrying_failed_effect
       and not (current_effect.replay_safe and coalesce(input_replay_safe, false)) then
      return jsonb_build_object(
        'recorded', false, 'replayed', true, 'reason', 'failed_effect_not_replay_safe',
        'effectId', current_effect.id, 'status', current_effect.status,
        'resultRef', current_effect.result_ref
      );
    end if;

    if not (
      input_status = current_effect.status
      or (current_effect.status = 'reserved' and input_status in ('running', 'failed', 'unknown'))
      or (current_effect.status = 'running' and input_status in ('succeeded', 'failed', 'unknown'))
      or retrying_failed_effect
      or (current_effect.status = 'unknown' and input_status in (
        'running', 'succeeded', 'compensated'
      ))
    ) then
      raise exception 'invalid_tool_effect_transition' using errcode = '55000';
    end if;
    update public.job_tool_effects
    set status = input_status,
        result_ref = case
          when retrying_failed_effect then input_result_ref
          else coalesce(input_result_ref, result_ref)
        end,
        replay_safe = replay_safe or coalesce(input_replay_safe, false),
        metadata = metadata || normalized_metadata,
        lease_version = input_lease_version,
        completed_at = case
          when input_status in ('succeeded', 'compensated') then v_now
          when retrying_failed_effect then null
          else completed_at
        end,
        updated_at = v_now
    where id = current_effect.id
    returning * into current_effect;
  else
    if input_status not in ('reserved', 'running') then
      raise exception 'tool_effect_must_be_reserved_first' using errcode = '55000';
    end if;
    insert into public.job_tool_effects(
      job_id, principal_id, tool_call_id, tool_name, args_hash, effect_key,
      status, replay_safe, result_ref, metadata, lease_version,
      created_at, updated_at
    ) values (
      current_job.id, current_job.principal_id, input_tool_call_id,
      input_tool_name, input_args_hash, input_effect_key, input_status,
      coalesce(input_replay_safe, false), input_result_ref, normalized_metadata,
      input_lease_version, v_now, v_now
    ) returning * into current_effect;
  end if;

  return jsonb_build_object(
    'recorded', true, 'replayed', false,
    'effectId', current_effect.id, 'status', current_effect.status,
    'resultRef', current_effect.result_ref
  );
end;
$$;

revoke all on function public.record_job_tool_effect(
  uuid,text,bigint,text,text,text,text,text,jsonb,boolean,jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.record_job_tool_effect(
  uuid,text,bigint,text,text,text,text,text,jsonb,boolean,jsonb
) to service_role;

commit;
