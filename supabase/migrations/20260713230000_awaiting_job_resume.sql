-- Authoritative pause/resume for jobs waiting on bounded user input.
-- Awaiting jobs release their worker lease immediately. Resumption is an
-- owner-bound, checkpoint-CAS command that only requeues durable work.
begin;

create extension if not exists pgcrypto;

-- Awaiting input is a durable, unleased state. Clean up rows written by the
-- previous contract before making the invariant structural.
update public.jobs
set lease_owner = null,
    lease_expires_at = null,
    updated_at = clock_timestamp()
where status = 'awaiting_input'
  and (lease_owner is not null or lease_expires_at is not null);

alter table public.jobs
  drop constraint if exists jobs_awaiting_input_unleased_check;
alter table public.jobs
  add constraint jobs_awaiting_input_unleased_check check (
    status <> 'awaiting_input'
    or (lease_owner is null and lease_expires_at is null)
  );

-- The state machine admits only an explicit resume command from awaiting_input
-- back to queued. A later claim increments the lease fence before work starts.
create or replace function public.enforce_job_state_contract()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if old.status in ('completed', 'failed', 'cancelled') and new is distinct from old then
    raise exception 'terminal_job_immutable' using errcode = '55000';
  end if;

  if new.id is distinct from old.id
     or new.type is distinct from old.type
     or new.queue is distinct from old.queue
     or new.principal_id is distinct from old.principal_id
     or new.auth_class is distinct from old.auth_class
     or new.subject is distinct from old.subject
     or new.idempotency_key is distinct from old.idempotency_key
     or new.input_hash is distinct from old.input_hash
     or new.payload is distinct from old.payload
     or new.budget is distinct from old.budget
     or new.max_attempts is distinct from old.max_attempts
     or new.created_at is distinct from old.created_at then
    raise exception 'job_identity_immutable' using errcode = '55000';
  end if;

  if not (
    new.status = old.status
    or (old.status = 'queued' and new.status in ('leased', 'failed', 'cancelled'))
    or (old.status = 'leased' and new.status in (
      'queued', 'running', 'awaiting_input', 'cancelling', 'completed', 'failed', 'cancelled'
    ))
    or (old.status = 'running' and new.status in (
      'queued', 'leased', 'awaiting_input', 'cancelling', 'completed', 'failed', 'cancelled'
    ))
    or (old.status = 'awaiting_input' and new.status in (
      'queued', 'cancelling', 'failed', 'cancelled'
    ))
    or (old.status = 'cancelling' and new.status in ('completed', 'failed', 'cancelled'))
  ) then
    raise exception 'invalid_job_state_transition:%->%', old.status, new.status
      using errcode = '55000';
  end if;

  if new.lease_version < old.lease_version then
    raise exception 'job_lease_version_regressed' using errcode = '55000';
  end if;
  if new.lease_owner is distinct from old.lease_owner
     and new.lease_owner is not null
     and new.lease_version <= old.lease_version then
    raise exception 'job_lease_owner_changed_without_fence' using errcode = '55000';
  end if;
  if new.attempt < old.attempt or new.event_sequence < old.event_sequence then
    raise exception 'job_monotonic_counter_regressed' using errcode = '55000';
  end if;
  if old.cancel_requested_at is not null and new.cancel_requested_at is null then
    raise exception 'job_cancel_request_immutable' using errcode = '55000';
  end if;
  return new;
end;
$$;

-- Preserve the fenced checkpoint and its lease_version, but relinquish the
-- live lease in the same transaction when the worker pauses for user input.
create or replace function public.checkpoint_job(
  input_job_id uuid,
  input_worker_id text,
  input_lease_version bigint,
  input_phase text,
  input_checkpoint jsonb,
  input_progress jsonb default '{}'::jsonb,
  input_resumable boolean default false,
  input_status text default 'running'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_job public.jobs%rowtype;
  checkpoint_version bigint;
  v_now timestamptz := clock_timestamp();
  normalized_checkpoint jsonb := coalesce(input_checkpoint, '{}'::jsonb);
  normalized_progress jsonb := coalesce(input_progress, '{}'::jsonb);
begin
  if input_job_id is null or input_worker_id is null
     or length(input_worker_id) not between 1 and 256
     or input_lease_version is null or input_lease_version < 1
     or input_phase is null or input_phase !~ '^[a-z][a-z0-9_.-]{0,127}$'
     or input_status not in ('running', 'awaiting_input')
     or jsonb_typeof(normalized_checkpoint) <> 'object'
     or jsonb_typeof(normalized_progress) <> 'object'
     or octet_length(normalized_checkpoint::text) > 1048576
     or octet_length(normalized_progress::text) > 786432 then
    raise exception 'invalid_job_checkpoint' using errcode = '22023';
  end if;

  select * into current_job from public.jobs
  where id = input_job_id
  for update;
  if not found then
    return jsonb_build_object(
      'checkpointed', false, 'reason', 'not_found', 'status', null,
      'checkpointVersion', null, 'eventSeq', null, 'cancelRequested', false
    );
  end if;
  if current_job.status in ('completed', 'failed', 'cancelled') then
    return jsonb_build_object(
      'checkpointed', false, 'reason', 'terminal', 'status', current_job.status,
      'checkpointVersion', null, 'eventSeq', current_job.event_sequence,
      'cancelRequested', current_job.cancel_requested_at is not null
    );
  end if;
  if current_job.cancel_requested_at is not null then
    return jsonb_build_object(
      'checkpointed', false, 'reason', 'cancel_requested',
      'status', current_job.status, 'checkpointVersion', null,
      'eventSeq', current_job.event_sequence, 'cancelRequested', true
    );
  end if;
  if current_job.lease_owner is distinct from input_worker_id
     or current_job.lease_version <> input_lease_version
     or current_job.lease_expires_at is null
     or current_job.lease_expires_at <= v_now then
    return jsonb_build_object(
      'checkpointed', false, 'reason', 'stale_fence',
      'status', current_job.status, 'checkpointVersion', null,
      'eventSeq', current_job.event_sequence,
      'cancelRequested', current_job.cancel_requested_at is not null
    );
  end if;

  insert into public.job_checkpoints(
    job_id, principal_id, version, phase, checkpoint, progress, resumable,
    lease_version, created_at, updated_at
  ) values (
    current_job.id, current_job.principal_id, 1, input_phase,
    normalized_checkpoint, normalized_progress, coalesce(input_resumable, false),
    input_lease_version, v_now, v_now
  )
  on conflict (job_id) do update
  set version = public.job_checkpoints.version + 1,
      phase = excluded.phase,
      checkpoint = excluded.checkpoint,
      progress = excluded.progress,
      resumable = excluded.resumable,
      lease_version = excluded.lease_version,
      updated_at = excluded.updated_at
  returning version into checkpoint_version;

  update public.jobs
  set status = input_status,
      progress = normalized_progress,
      event_sequence = event_sequence + 1,
      lease_owner = case when input_status = 'awaiting_input' then null else lease_owner end,
      lease_expires_at = case when input_status = 'awaiting_input' then null else lease_expires_at end,
      updated_at = v_now
  where id = current_job.id
    and lease_owner = input_worker_id
    and lease_version = input_lease_version
    and lease_expires_at > v_now
  returning * into current_job;
  if not found then
    raise exception 'job_fence_changed_during_checkpoint' using errcode = '40001';
  end if;

  insert into public.job_events(
    job_id, principal_id, seq, kind, payload, worker_id, lease_version, created_at
  ) values (
    current_job.id, current_job.principal_id, current_job.event_sequence,
    'job.checkpoint',
    jsonb_build_object(
      'status', current_job.status, 'phase', input_phase,
      'checkpointVersion', checkpoint_version,
      'resumable', coalesce(input_resumable, false),
      'leaseReleased', input_status = 'awaiting_input',
      'progress', normalized_progress
    ),
    input_worker_id, input_lease_version, v_now
  );

  perform public.mirror_chat_job_progress(current_job);
  if current_job.type = 'agent.task' then
    update public.agent_tasks
    set status = case
          when input_status = 'awaiting_input' then 'waiting_for_user'
          else 'running'
        end,
        updated_at = v_now
    where id = (current_job.subject->>'taskId')::uuid
      and user_id = current_job.principal_id
      and status not in ('completed', 'failed', 'cancelled');
  end if;

  return jsonb_build_object(
    'checkpointed', true,
    'status', current_job.status,
    'checkpointVersion', checkpoint_version,
    'eventSeq', current_job.event_sequence,
    'leaseReleased', input_status = 'awaiting_input',
    'cancelRequested', false
  );
end;
$$;

revoke all on function public.checkpoint_job(
  uuid,text,bigint,text,jsonb,jsonb,boolean,text
) from public, anon, authenticated;
grant execute on function public.checkpoint_job(
  uuid,text,bigint,text,jsonb,jsonb,boolean,text
) to service_role;

create unique index if not exists audit_log_job_resume_request_unique
  on public.audit_log(job_id, request_id)
  where action = 'job.resumed' and request_id is not null;

create or replace function public.resume_awaiting_job(
  input_job_id uuid,
  input_principal_id uuid,
  input_expected_checkpoint_version bigint,
  input_idempotency_key text,
  input_resume_input jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  current_job public.jobs%rowtype;
  current_checkpoint public.job_checkpoints%rowtype;
  existing_event public.job_events%rowtype;
  v_now timestamptz := clock_timestamp();
  v_uid uuid := auth.uid();
  v_claim_role text := nullif(current_setting('request.jwt.claim.role', true), '');
  v_database_role text := nullif(current_setting('role', true), '');
  normalized_input jsonb := coalesce(input_resume_input, '{}'::jsonb);
  resume_input_hash text;
  next_checkpoint_version bigint;
begin
  if input_job_id is null or input_principal_id is null
     or input_expected_checkpoint_version is null or input_expected_checkpoint_version < 1
     or coalesce(length(input_idempotency_key), 0) not between 8 and 200
     or input_idempotency_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$'
     or jsonb_typeof(normalized_input) <> 'object'
     or octet_length(normalized_input::text) > 65536 then
    raise exception 'invalid_awaiting_job_resume' using errcode = '22023';
  end if;

  if v_uid is not null then
    if v_uid is distinct from input_principal_id then
      raise exception 'awaiting_job_resume_actor_mismatch' using errcode = '42501';
    end if;
  elsif v_claim_role is distinct from 'service_role'
        and v_database_role is distinct from 'service_role' then
    raise exception 'awaiting_job_resume_actor_missing' using errcode = '42501';
  end if;

  resume_input_hash := encode(
    digest(convert_to(normalized_input::text, 'UTF8'), 'sha256'), 'hex'
  );

  select * into current_job
  from public.jobs
  where id = input_job_id and principal_id = input_principal_id
  for update;
  if not found then
    return jsonb_build_object(
      'resumed', false, 'replayed', false, 'reason', 'not_found',
      'status', null, 'checkpointVersion', null, 'eventSeq', null
    );
  end if;

  select * into existing_event
  from public.job_events
  where job_id = current_job.id and idempotency_key = input_idempotency_key;
  if found then
    if existing_event.kind <> 'job.resumed'
       or existing_event.payload->>'expectedCheckpointVersion'
          is distinct from input_expected_checkpoint_version::text
       or existing_event.payload->>'resumeInputSha256' is distinct from resume_input_hash then
      return jsonb_build_object(
        'resumed', false, 'replayed', false, 'reason', 'idempotency_conflict',
        'status', current_job.status,
        'checkpointVersion', existing_event.payload->'checkpointVersion',
        'eventSeq', current_job.event_sequence
      );
    end if;
    return jsonb_build_object(
      'resumed', true, 'replayed', true, 'reason', null,
      'status', current_job.status,
      'checkpointVersion', existing_event.payload->'checkpointVersion',
      'eventSeq', existing_event.seq
    );
  end if;

  if current_job.cancel_requested_at is not null then
    return jsonb_build_object(
      'resumed', false, 'replayed', false, 'reason', 'cancel_requested',
      'status', current_job.status, 'checkpointVersion', null,
      'eventSeq', current_job.event_sequence
    );
  end if;
  if current_job.status <> 'awaiting_input' then
    return jsonb_build_object(
      'resumed', false, 'replayed', false, 'reason', 'not_awaiting_input',
      'status', current_job.status, 'checkpointVersion', null,
      'eventSeq', current_job.event_sequence
    );
  end if;

  select * into current_checkpoint
  from public.job_checkpoints
  where job_id = current_job.id
  for update;
  if not found then
    return jsonb_build_object(
      'resumed', false, 'replayed', false, 'reason', 'checkpoint_missing',
      'status', current_job.status, 'checkpointVersion', null,
      'eventSeq', current_job.event_sequence
    );
  end if;
  if not current_checkpoint.resumable then
    return jsonb_build_object(
      'resumed', false, 'replayed', false, 'reason', 'checkpoint_not_resumable',
      'status', current_job.status,
      'checkpointVersion', current_checkpoint.version,
      'eventSeq', current_job.event_sequence
    );
  end if;
  if current_checkpoint.version <> input_expected_checkpoint_version then
    return jsonb_build_object(
      'resumed', false, 'replayed', false, 'reason', 'checkpoint_version_conflict',
      'status', current_job.status,
      'checkpointVersion', current_checkpoint.version,
      'eventSeq', current_job.event_sequence
    );
  end if;

  update public.job_checkpoints
  set version = version + 1,
      checkpoint = jsonb_set(checkpoint, '{resumeInput}', normalized_input, true),
      updated_at = v_now
  where job_id = current_job.id
    and version = input_expected_checkpoint_version
    and resumable
  returning version into next_checkpoint_version;
  if not found then
    raise exception 'awaiting_job_checkpoint_cas_changed' using errcode = '40001';
  end if;

  update public.jobs
  set status = 'queued',
      available_at = v_now,
      event_sequence = event_sequence + 1,
      lease_owner = null,
      lease_expires_at = null,
      updated_at = v_now
  where id = current_job.id
    and status = 'awaiting_input'
    and lease_owner is null
    and lease_expires_at is null
  returning * into current_job;
  if not found then
    raise exception 'awaiting_job_resume_cas_changed' using errcode = '40001';
  end if;

  insert into public.job_events(
    job_id, principal_id, seq, kind, idempotency_key, schema_version,
    payload, created_at
  ) values (
    current_job.id, current_job.principal_id, current_job.event_sequence,
    'job.resumed', input_idempotency_key, 1,
    jsonb_build_object(
      'status', current_job.status,
      'expectedCheckpointVersion', input_expected_checkpoint_version,
      'checkpointVersion', next_checkpoint_version,
      'resumeInputSha256', resume_input_hash
    ),
    v_now
  );

  if current_job.type = 'agent.task' then
    update public.agent_tasks
    set status = 'queued', error = null, finished_at = null, updated_at = v_now
    where id = (current_job.subject->>'taskId')::uuid
      and user_id = current_job.principal_id
      and status = 'waiting_for_user';
    if not found then
      raise exception 'agent_task_resume_projection_missing' using errcode = '23503';
    end if;
  end if;

  insert into public.audit_log(
    principal_id, actor_type, actor_id, action, resource_type, resource_id,
    job_id, request_id, metadata, created_at
  ) values (
    current_job.principal_id,
    case when v_uid is null then 'service' else 'user' end,
    coalesce(v_uid::text, 'service_role'),
    'job.resumed', 'job', current_job.id::text,
    current_job.id, input_idempotency_key,
    jsonb_build_object(
      'expectedCheckpointVersion', input_expected_checkpoint_version,
      'checkpointVersion', next_checkpoint_version,
      'eventSeq', current_job.event_sequence,
      'resumeInputSha256', resume_input_hash
    ),
    v_now
  );

  return jsonb_build_object(
    'resumed', true, 'replayed', false, 'reason', null,
    'status', current_job.status,
    'checkpointVersion', next_checkpoint_version,
    'eventSeq', current_job.event_sequence
  );
end;
$$;

revoke all on function public.resume_awaiting_job(uuid,uuid,bigint,text,jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.resume_awaiting_job(uuid,uuid,bigint,text,jsonb)
  to authenticated, service_role;

create or replace function public.runtime_healthcheck_v8()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.runtime_healthcheck_v7()
    and to_regprocedure(
      'public.resume_awaiting_job(uuid,uuid,bigint,text,jsonb)'
    ) is not null
    and has_function_privilege(
      'service_role',
      'public.resume_awaiting_job(uuid,uuid,bigint,text,jsonb)',
      'EXECUTE'
    )
    and has_function_privilege(
      'authenticated',
      'public.resume_awaiting_job(uuid,uuid,bigint,text,jsonb)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'public.resume_awaiting_job(uuid,uuid,bigint,text,jsonb)',
      'EXECUTE'
    )
    and exists (
      select 1
      from pg_constraint
      where conrelid = 'public.jobs'::regclass
        and conname = 'jobs_awaiting_input_unleased_check'
        and contype = 'c'
    );
$$;

revoke all on function public.runtime_healthcheck_v8()
  from public, anon, authenticated, service_role;
grant execute on function public.runtime_healthcheck_v8() to service_role;

commit;
