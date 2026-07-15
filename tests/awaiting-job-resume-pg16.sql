\set ON_ERROR_STOP on

insert into public.agent_tasks(id, user_id, goal, status) values (
  '89800000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000001',
  'resume projection fixture', 'queued'
);
insert into public.code_messages(id, session_id, user_id, role, content) values (
  '89800000-0000-4000-8000-000000000010',
  '80600000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000001',
  'assistant', ''
);

set role service_role;
set request.jwt.claim.role = 'service_role';
do $$
declare result jsonb;
begin
  if not public.runtime_healthcheck_v8() then
    raise exception 'v8 resume readiness contract failed';
  end if;
  perform public.enqueue_job(
    '89800000-0000-4000-8000-000000000002', 'agent.task', 'resume_agent',
    '00000000-0000-4000-8000-000000000001', 'registered',
    jsonb_build_object(
      'taskId', '89800000-0000-4000-8000-000000000001',
      'repo', 'owner/repo',
      'sessionId', '80600000-0000-4000-8000-000000000001',
      'responseId', '89800000-0000-4000-8000-000000000010',
      'userMessageId', '80700000-0000-4000-8000-000000000001'
    ),
    'resume-agent-intent', repeat('1', 64)
  );
  result := public.claim_next_job('resume-worker-1', array['resume_agent'], 120);
  if result->>'acquired' <> 'true' then
    raise exception 'resume agent fixture claim failed: %', result;
  end if;
  result := public.checkpoint_job(
    '89800000-0000-4000-8000-000000000002', 'resume-worker-1', 1,
    'agent.await_user', '{"schemaVersion":1,"trajectory":[]}'::jsonb,
    '{"question":"continue?"}'::jsonb, true, 'awaiting_input'
  );
  if result->>'checkpointed' <> 'true'
     or result->>'leaseReleased' <> 'true'
     or (select lease_owner from public.jobs
         where id = '89800000-0000-4000-8000-000000000002') is not null
     or (select lease_expires_at from public.jobs
         where id = '89800000-0000-4000-8000-000000000002') is not null
     or (select lease_version from public.jobs
         where id = '89800000-0000-4000-8000-000000000002') <> 1
     or (select status from public.agent_tasks
         where id = '89800000-0000-4000-8000-000000000001') <> 'waiting_for_user' then
    raise exception 'awaiting checkpoint did not release lease and preserve fence: %', result;
  end if;

  perform public.enqueue_job(
    '89800000-0000-4000-8000-000000000003', 'cleanup.resume_unsafe', 'resume_unsafe',
    '00000000-0000-4000-8000-000000000001', 'registered', '{}'::jsonb,
    'resume-unsafe-intent', repeat('2', 64)
  );
  perform public.claim_next_job('resume-unsafe-worker', array['resume_unsafe'], 120);
  perform public.checkpoint_job(
    '89800000-0000-4000-8000-000000000003', 'resume-unsafe-worker', 1,
    'cleanup.await_user', '{"schemaVersion":1}'::jsonb, '{}'::jsonb,
    false, 'awaiting_input'
  );

  perform public.enqueue_job(
    '89800000-0000-4000-8000-000000000004', 'cleanup.resume_cas', 'resume_cas',
    '00000000-0000-4000-8000-000000000001', 'registered', '{}'::jsonb,
    'resume-cas-intent', repeat('3', 64)
  );
  perform public.claim_next_job('resume-cas-worker', array['resume_cas'], 120);
  perform public.checkpoint_job(
    '89800000-0000-4000-8000-000000000004', 'resume-cas-worker', 1,
    'cleanup.await_user', '{"schemaVersion":1}'::jsonb, '{}'::jsonb,
    true, 'awaiting_input'
  );

  -- Left awaiting for the shell verifier's real two-session idempotency race.
  perform public.enqueue_job(
    '89800000-0000-4000-8000-000000000005', 'cleanup.resume_race', 'resume_race',
    '00000000-0000-4000-8000-000000000001', 'registered', '{}'::jsonb,
    'resume-race-intent', repeat('4', 64)
  );
  perform public.claim_next_job('resume-race-worker', array['resume_race'], 120);
  perform public.checkpoint_job(
    '89800000-0000-4000-8000-000000000005', 'resume-race-worker', 1,
    'cleanup.await_user', '{"schemaVersion":1}'::jsonb, '{}'::jsonb,
    true, 'awaiting_input'
  );
end;
$$;
reset request.jwt.claim.role;
reset role;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-4000-8000-000000000001';
set request.jwt.claim.role = 'authenticated';
do $$
declare result jsonb;
begin
  if not has_function_privilege(
       'authenticated', 'public.resume_awaiting_job(uuid,uuid,bigint,text,jsonb)', 'EXECUTE'
     )
     or not has_function_privilege(
       'service_role', 'public.resume_awaiting_job(uuid,uuid,bigint,text,jsonb)', 'EXECUTE'
     )
     or has_function_privilege(
       'anon', 'public.resume_awaiting_job(uuid,uuid,bigint,text,jsonb)', 'EXECUTE'
     ) then
    raise exception 'resume RPC grants are not owner/service-only';
  end if;

  result := public.resume_awaiting_job(
    '89800000-0000-4000-8000-000000000002',
    '00000000-0000-4000-8000-000000000001', 1,
    'resume-request-0001', '{"answer":"continue"}'::jsonb
  );
  if result->>'resumed' <> 'true' or result->>'replayed' <> 'false'
     or result->>'status' <> 'queued' or result->>'checkpointVersion' <> '2'
     or (select status from public.agent_tasks
         where id = '89800000-0000-4000-8000-000000000001') <> 'queued'
     or (select count(*) from public.job_events
         where job_id = '89800000-0000-4000-8000-000000000002'
           and kind = 'job.resumed') <> 1 then
    raise exception 'owner resume transaction was incomplete: %', result;
  end if;

  result := public.resume_awaiting_job(
    '89800000-0000-4000-8000-000000000003',
    '00000000-0000-4000-8000-000000000001', 1,
    'resume-request-unsafe', '{}'::jsonb
  );
  if result->>'reason' <> 'checkpoint_not_resumable' then
    raise exception 'non-resumable checkpoint resumed: %', result;
  end if;

  result := public.resume_awaiting_job(
    '89800000-0000-4000-8000-000000000004',
    '00000000-0000-4000-8000-000000000001', 2,
    'resume-request-stale', '{}'::jsonb
  );
  if result->>'reason' <> 'checkpoint_version_conflict' then
    raise exception 'stale checkpoint CAS was accepted: %', result;
  end if;

  begin
    perform public.resume_awaiting_job(
      '89800000-0000-4000-8000-000000000004',
      '00000000-0000-4000-8000-000000000002', 1,
      'resume-request-wrong-owner', '{}'::jsonb
    );
    raise exception 'cross-tenant resume was accepted';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset request.jwt.claim.sub;
reset request.jwt.claim.role;
reset role;

do $$
begin
  if (select checkpoint->'resumeInput'->>'answer' from public.job_checkpoints
      where job_id = '89800000-0000-4000-8000-000000000002') <> 'continue'
     or (select count(*) from public.audit_log
         where job_id = '89800000-0000-4000-8000-000000000002'
           and action = 'job.resumed') <> 1 then
    raise exception 'resume checkpoint or audit mutation was missing';
  end if;
end;
$$;

set role service_role;
set request.jwt.claim.role = 'service_role';
do $$
declare claimed jsonb;
begin
  claimed := public.claim_next_job('resume-worker-2', array['resume_agent'], 120);
  if claimed->>'acquired' <> 'true'
     or claimed->'job'->>'id' <> '89800000-0000-4000-8000-000000000002'
     or claimed->'job'->>'leaseVersion' <> '2'
     or claimed->'job'->'checkpoint'->>'version' <> '2'
     or claimed->'job'->'checkpoint'->'data'->'resumeInput'->>'answer' <> 'continue' then
    raise exception 'resume input was not returned to the next fenced claim: %', claimed;
  end if;
end;
$$;
reset request.jwt.claim.role;
reset role;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-4000-8000-000000000001';
set request.jwt.claim.role = 'authenticated';
do $$
declare result jsonb;
begin
  result := public.resume_awaiting_job(
    '89800000-0000-4000-8000-000000000002',
    '00000000-0000-4000-8000-000000000001', 1,
    'resume-request-0001', '{"answer":"continue"}'::jsonb
  );
  if result->>'resumed' <> 'true' or result->>'replayed' <> 'true'
     or (select count(*) from public.job_events
         where job_id = '89800000-0000-4000-8000-000000000002'
           and kind = 'job.resumed') <> 1 then
    raise exception 'resume replay was not idempotent: %', result;
  end if;

  result := public.resume_awaiting_job(
    '89800000-0000-4000-8000-000000000002',
    '00000000-0000-4000-8000-000000000001', 1,
    'resume-request-0001', '{"answer":"changed"}'::jsonb
  );
  if result->>'reason' <> 'idempotency_conflict' then
    raise exception 'idempotency key payload swap was accepted: %', result;
  end if;
end;
$$;
reset request.jwt.claim.sub;
reset request.jwt.claim.role;
reset role;

set role anon;
do $$
begin
  begin
    perform public.resume_awaiting_job(
      '89800000-0000-4000-8000-000000000004',
      '00000000-0000-4000-8000-000000000001', 1,
      'resume-request-anon', '{}'::jsonb
    );
    raise exception 'anonymous role resumed a job';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset role;
