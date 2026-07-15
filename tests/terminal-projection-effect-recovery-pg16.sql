\set ON_ERROR_STOP on

insert into public.agent_tasks(id, user_id, goal, status) values
  ('89900000-0000-4000-8000-000000000001',
   '00000000-0000-4000-8000-000000000001', 'queued cancel projection', 'queued'),
  ('89900000-0000-4000-8000-000000000002',
   '00000000-0000-4000-8000-000000000001', 'stale failure projection', 'queued');

-- The production service reaches these rows through SECURITY DEFINER RPCs;
-- this read-only grant is only for assertions inside the service-role fixture.
grant select on public.code_messages to service_role;

set role service_role;
do $$
declare result jsonb;
begin
  perform public.enqueue_job(
    '89900000-0000-4000-8000-000000000011', 'agent.task', 'terminal_cancel',
    '00000000-0000-4000-8000-000000000001', 'registered',
    jsonb_build_object(
      'taskId', '89900000-0000-4000-8000-000000000001',
      'repo', 'owner/repo',
      'sessionId', '80600000-0000-4000-8000-000000000001',
      'responseId', '89900000-0000-4000-8000-000000000021',
      'userMessageId', '80700000-0000-4000-8000-000000000001'
    ),
    'terminal-cancel-intent', repeat('a', 64),
    jsonb_build_object('billingClass', 'customer')
  );
  result := public.cancel_job(
    '89900000-0000-4000-8000-000000000011',
    '00000000-0000-4000-8000-000000000001', 'fixture cancel'
  );
  if result->>'status' <> 'cancelled'
     or (select status from public.agent_tasks
         where id = '89900000-0000-4000-8000-000000000001') <> 'cancelled'
     or (select content from public.code_messages
         where id = '89900000-0000-4000-8000-000000000021') <> '已停止。'
     or (select meta->>'status' from public.code_messages
         where id = '89900000-0000-4000-8000-000000000021') <> 'cancelled' then
    raise exception 'queued cancellation did not atomically project: %', result;
  end if;

  perform public.enqueue_job(
    '89900000-0000-4000-8000-000000000012', 'agent.task', 'terminal_stale',
    '00000000-0000-4000-8000-000000000001', 'registered',
    jsonb_build_object(
      'taskId', '89900000-0000-4000-8000-000000000002',
      'repo', 'owner/repo',
      'sessionId', '80600000-0000-4000-8000-000000000001',
      'responseId', '89900000-0000-4000-8000-000000000022',
      'userMessageId', '80700000-0000-4000-8000-000000000001'
    ),
    'terminal-stale-intent', repeat('b', 64),
    jsonb_build_object('billingClass', 'customer'), '{}'::jsonb,
    0, 1
  );
  result := public.claim_next_job('terminal-stale-worker', array['terminal_stale'], 15);
  if result->>'acquired' <> 'true' then
    raise exception 'stale projection fixture was not claimed: %', result;
  end if;

  perform public.enqueue_job(
    '89900000-0000-4000-8000-000000000013', 'cleanup.effect_recovery', 'effect_recovery',
    '00000000-0000-4000-8000-000000000001', 'registered', '{}'::jsonb,
    'effect-recovery-intent', repeat('c', 64),
    jsonb_build_object('billingClass', 'customer')
  );
  result := public.claim_next_job('effect-recovery-worker', array['effect_recovery'], 120);
  if result->>'acquired' <> 'true' then
    raise exception 'effect recovery fixture was not claimed: %', result;
  end if;

  perform public.record_job_tool_effect(
    '89900000-0000-4000-8000-000000000013', 'effect-recovery-worker', 1,
    'replay-safe-call', 'web_search', repeat('d', 64), 'effect:replay-safe',
    'reserved', null, true, '{}'
  );
  perform public.record_job_tool_effect(
    '89900000-0000-4000-8000-000000000013', 'effect-recovery-worker', 1,
    'replay-safe-call', 'web_search', repeat('d', 64), 'effect:replay-safe',
    'running', null, true, '{}'
  );
  perform public.record_job_tool_effect(
    '89900000-0000-4000-8000-000000000013', 'effect-recovery-worker', 1,
    'replay-safe-call', 'web_search', repeat('d', 64), 'effect:replay-safe',
    'failed', '{"error":"provider"}', true, '{}'
  );
  result := public.record_job_tool_effect(
    '89900000-0000-4000-8000-000000000013', 'effect-recovery-worker', 1,
    'replay-safe-call', 'web_search', repeat('d', 64), 'effect:replay-safe',
    'reserved', null, true, '{}'
  );
  if result->>'recorded' <> 'true' or result->>'status' <> 'reserved'
     or (select result_ref from public.job_tool_effects
         where effect_key = 'effect:replay-safe') is not null then
    raise exception 'replay-safe failed effect did not reserve cleanly: %', result;
  end if;
  perform public.record_job_tool_effect(
    '89900000-0000-4000-8000-000000000013', 'effect-recovery-worker', 1,
    'replay-safe-call', 'web_search', repeat('d', 64), 'effect:replay-safe',
    'running', null, true, '{}'
  );
  perform public.record_job_tool_effect(
    '89900000-0000-4000-8000-000000000013', 'effect-recovery-worker', 1,
    'replay-safe-call', 'web_search', repeat('d', 64), 'effect:replay-safe',
    'succeeded', '{"result":"ok"}', true, '{}'
  );

  perform public.record_job_tool_effect(
    '89900000-0000-4000-8000-000000000013', 'effect-recovery-worker', 1,
    'unsafe-call', 'publish', repeat('e', 64), 'effect:unsafe',
    'reserved', null, false, '{}'
  );
  perform public.record_job_tool_effect(
    '89900000-0000-4000-8000-000000000013', 'effect-recovery-worker', 1,
    'unsafe-call', 'publish', repeat('e', 64), 'effect:unsafe',
    'running', null, false, '{}'
  );
  perform public.record_job_tool_effect(
    '89900000-0000-4000-8000-000000000013', 'effect-recovery-worker', 1,
    'unsafe-call', 'publish', repeat('e', 64), 'effect:unsafe',
    'failed', '{"error":"ambiguous"}', false, '{}'
  );
  result := public.record_job_tool_effect(
    '89900000-0000-4000-8000-000000000013', 'effect-recovery-worker', 1,
    'unsafe-call', 'publish', repeat('e', 64), 'effect:unsafe',
    'reserved', null, false, '{}'
  );
  if result->>'recorded' <> 'false' or result->>'replayed' <> 'true'
     or result->>'reason' <> 'failed_effect_not_replay_safe'
     or (select status from public.job_tool_effects
         where effect_key = 'effect:unsafe') <> 'failed' then
    raise exception 'unsafe failed effect was allowed to replay: %', result;
  end if;
end;
$$;
reset role;

update public.jobs
set lease_expires_at = clock_timestamp() - interval '1 second'
where id = '89900000-0000-4000-8000-000000000012';

set role service_role;
do $$
declare result jsonb;
begin
  result := public.claim_next_job('terminal-recovery-worker', array['terminal_stale'], 15);
  if result->>'acquired' <> 'false' or result->>'reason' <> 'job_attempts_exhausted'
     or (select status from public.agent_tasks
         where id = '89900000-0000-4000-8000-000000000002') <> 'failed'
     or (select content from public.code_messages
         where id = '89900000-0000-4000-8000-000000000022') <> '任务执行失败，请稍后重试。'
     or (select meta->>'errorCode' from public.code_messages
         where id = '89900000-0000-4000-8000-000000000022') <> 'job_attempts_exhausted' then
    raise exception 'stale terminal path did not atomically project: %', result;
  end if;

  if has_function_privilege(
       'authenticated',
       'public.record_job_tool_effect(uuid,text,bigint,text,text,text,text,text,jsonb,boolean,jsonb)',
       'EXECUTE'
     ) then
    raise exception 'authenticated retained tool-effect mutation privilege';
  end if;
end;
$$;
reset role;
