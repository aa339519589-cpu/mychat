-- A persisted checkpoint is the authority for stale-lease recovery. A worker
-- must never restart a job whose latest checkpoint explicitly says that the
-- current phase cannot be replayed, even when no tool-effect receipt exists.
begin;

create or replace function public.claim_next_job(
  input_worker_id text,
  input_queues text[] default null,
  input_lease_seconds integer default 120
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_job public.jobs%rowtype;
  v_now timestamptz := clock_timestamp();
  lease_duration integer := greatest(15, least(coalesce(input_lease_seconds, 120), 900));
  stale_recoverable boolean;
  terminal_reason text;
begin
  if input_worker_id is null or length(input_worker_id) not between 1 and 256
     or input_lease_seconds is null or input_lease_seconds not between 15 and 900
     or (
       input_queues is not null
       and exists (
         select 1 from unnest(input_queues) as queue_name
         where queue_name is null or queue_name !~ '^[a-z][a-z0-9_.-]{0,63}$'
       )
     ) then
    raise exception 'invalid_job_claim' using errcode = '22023';
  end if;

  select * into current_job
  from public.jobs as candidate
  where (
      input_queues is null
      or cardinality(input_queues) = 0
      or candidate.queue = any(input_queues)
    )
    and candidate.available_at <= v_now
    and (
      candidate.status = 'queued'
      or (
        candidate.status in ('leased', 'running', 'cancelling')
        and (candidate.lease_expires_at is null or candidate.lease_expires_at <= v_now)
      )
    )
  order by candidate.priority desc,
    (
      select count(*) from public.jobs as active
      where active.principal_id = candidate.principal_id
        and active.status in ('leased', 'running', 'cancelling')
        and active.lease_expires_at > v_now
    ) asc,
    candidate.available_at, candidate.created_at, candidate.id
  for update skip locked
  limit 1;

  if not found then
    return jsonb_build_object('acquired', false, 'reason', 'empty', 'job', null);
  end if;

  if current_job.status = 'cancelling' or current_job.cancel_requested_at is not null then
    update public.jobs
    set status = 'cancelled',
        result = coalesce(result, '{}'::jsonb),
        error_class = null,
        error_code = null,
        event_sequence = event_sequence + 1,
        lease_owner = null,
        lease_expires_at = null,
        terminal_at = v_now,
        updated_at = v_now
    where id = current_job.id
    returning * into current_job;

    insert into public.job_events(
      job_id, principal_id, seq, kind, payload, created_at
    ) values (
      current_job.id, current_job.principal_id, current_job.event_sequence,
      'job.terminal',
      jsonb_build_object(
        'status', current_job.status, 'result', current_job.result,
        'errorClass', current_job.error_class, 'errorCode', current_job.error_code,
        'retryable', current_job.error_class in ('retryable', 'provider')
      ),
      v_now
    );
    insert into public.job_outbox(
      job_id, principal_id, topic, dedupe_key, payload, created_at, updated_at
    ) values (
      current_job.id, current_job.principal_id, 'jobs.terminal',
      current_job.id::text || ':terminal',
      jsonb_build_object('jobId', current_job.id, 'status', current_job.status),
      v_now, v_now
    ) on conflict (job_id, dedupe_key) do nothing;
    perform public.mirror_chat_job_terminal(current_job);
    return jsonb_build_object(
      'acquired', false, 'reason', 'cancelled',
      'job', public.job_contract_json(current_job)
    );
  end if;

  if current_job.status <> 'queued' then
    select
      coalesce((
        select checkpoint.resumable
        from public.job_checkpoints as checkpoint
        where checkpoint.job_id = current_job.id
      ), true)
      and not exists (
        select 1 from public.job_tool_effects
        where job_id = current_job.id
          and (
            status in ('running', 'unknown')
            or (
              not replay_safe and (
                status = 'failed'
                or (status = 'succeeded' and not (coalesce(result_ref, '{}'::jsonb) ? 'result'))
              )
            )
          )
      ) into stale_recoverable;

    if current_job.attempt >= current_job.max_attempts or not stale_recoverable then
      terminal_reason := case
        when current_job.attempt >= current_job.max_attempts
          then 'job_attempts_exhausted'
        else 'stale_lease_unrecoverable'
      end;
      update public.jobs
      set status = 'failed',
          result = coalesce(result, '{}'::jsonb),
          error_class = 'internal',
          error_code = terminal_reason,
          event_sequence = event_sequence + 1,
          lease_owner = null,
          lease_expires_at = null,
          terminal_at = v_now,
          updated_at = v_now
      where id = current_job.id
      returning * into current_job;

      insert into public.job_events(
        job_id, principal_id, seq, kind, payload, created_at
      ) values (
        current_job.id, current_job.principal_id, current_job.event_sequence,
        'job.terminal',
        jsonb_build_object(
          'status', current_job.status, 'result', current_job.result,
          'errorClass', current_job.error_class, 'errorCode', current_job.error_code,
          'retryable', current_job.error_class in ('retryable', 'provider')
        ),
        v_now
      );
      insert into public.job_outbox(
        job_id, principal_id, topic, dedupe_key, payload, created_at, updated_at
      ) values (
        current_job.id, current_job.principal_id, 'jobs.terminal',
        current_job.id::text || ':terminal',
        jsonb_build_object(
          'jobId', current_job.id, 'status', current_job.status,
          'errorCode', current_job.error_code
        ),
        v_now, v_now
      ) on conflict (job_id, dedupe_key) do nothing;
      perform public.mirror_chat_job_terminal(current_job);
      return jsonb_build_object(
        'acquired', false, 'reason', terminal_reason,
        'job', public.job_contract_json(current_job)
      );
    end if;
  end if;

  update public.jobs
  set status = 'leased',
      attempt = attempt + 1,
      lease_owner = input_worker_id,
      lease_version = lease_version + 1,
      lease_expires_at = v_now + make_interval(secs => lease_duration),
      started_at = coalesce(started_at, v_now),
      event_sequence = event_sequence + 1,
      updated_at = v_now
  where id = current_job.id
  returning * into current_job;

  insert into public.job_events(
    job_id, principal_id, seq, kind, payload, worker_id, lease_version, created_at
  ) values (
    current_job.id, current_job.principal_id, current_job.event_sequence,
    'job.leased',
    jsonb_build_object(
      'status', current_job.status,
      'attempt', current_job.attempt,
      'leaseVersion', current_job.lease_version,
      'leaseExpiresAt', current_job.lease_expires_at
    ),
    input_worker_id, current_job.lease_version, v_now
  );

  if current_job.type = 'chat.generation' then
    update public.chat_generations
    set status = 'running',
        sequence = least(current_job.event_sequence, 2147483647)::integer,
        updated_at = v_now
    where id = current_job.id and status = 'queued';
  elsif current_job.type = 'agent.task' then
    update public.agent_tasks
    set status = 'running', updated_at = v_now,
        started_at = coalesce(started_at, v_now)
    where id = (current_job.subject->>'taskId')::uuid
      and user_id = current_job.principal_id
      and status not in ('completed', 'failed', 'cancelled');
  end if;

  return jsonb_build_object(
    'acquired', true,
    'job', public.job_contract_json(current_job)
  );
end;
$$;

revoke all on function public.claim_next_job(text,text[],integer)
  from public, anon, authenticated;
grant execute on function public.claim_next_job(text,text[],integer)
  to service_role;

commit;
