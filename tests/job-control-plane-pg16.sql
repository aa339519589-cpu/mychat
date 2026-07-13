\set ON_ERROR_STOP on

do $$
begin
  if not public.runtime_healthcheck_v4() then
    raise exception 'unified job readiness failed';
  end if;
  if has_function_privilege(
    'authenticated',
    'public.finalize_job(uuid,text,bigint,text,jsonb,text,text,jsonb,jsonb)',
    'EXECUTE'
  ) or has_function_privilege(
    'authenticated',
    'public.retry_job(uuid,text,bigint,text,text,integer)',
    'EXECUTE'
  ) or has_table_privilege('authenticated', 'public.jobs', 'UPDATE') then
    raise exception 'job control mutation leaked to authenticated';
  end if;
end;
$$;

-- The focused migration harness keeps only the columns touched by the unified
-- agent projection; the production base schema already provides this table.
create table if not exists public.agent_tasks (
  id uuid primary key,
  user_id uuid not null references auth.users(id),
  status text not null default 'queued',
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);
create table if not exists public.code_sessions (
  id uuid primary key,
  user_id uuid not null references auth.users(id),
  repo text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists public.code_messages (
  id uuid primary key,
  session_id uuid not null references public.code_sessions(id),
  user_id uuid not null references auth.users(id),
  role text not null,
  content text not null default '',
  meta jsonb,
  created_at timestamptz not null default now()
);
insert into public.agent_tasks(id, user_id) values
  ('80500000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001');
insert into public.code_sessions(id, user_id, repo) values
  ('80600000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'owner/repo');
insert into public.code_messages(id, session_id, user_id, role, content) values
  ('80700000-0000-4000-8000-000000000001', '80600000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'user', 'implement it');

insert into public.conversations(id, user_id) values
  ('80000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001'),
  ('80000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001');
insert into public.messages(id, conversation_id, user_id, role, content) values
  ('81000000-0000-4000-8000-000000000001', '80000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'user', 'control plane test'),
  ('81000000-0000-4000-8000-000000000002', '80000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'assistant', '');
insert into storage.objects(bucket_id, name) values (
  'job-payloads',
  '00000000-0000-4000-8000-000000000001/82700000-0000-4000-8000-000000000001/'
    || repeat('6', 64) || '.json'
);

set role service_role;
do $$
declare
  result jsonb;
begin
  result := public.enqueue_job(
    input_job_id => '82000000-0000-4000-8000-000000000001',
    input_type => 'chat.generation',
    input_queue => 'ideal_chat',
    input_principal_id => '00000000-0000-4000-8000-000000000001',
    input_auth_class => 'registered',
    input_subject => jsonb_build_object(
      'conversationId', '80000000-0000-4000-8000-000000000001',
      'userMessageId', '81000000-0000-4000-8000-000000000001',
      'assistantMessageId', '81000000-0000-4000-8000-000000000002'
    ),
    input_idempotency_key => 'pg16-chat-intent',
    input_input_hash => repeat('a', 64),
    input_payload => jsonb_build_object('outputKind', 'text')
  );
  if result->>'enqueued' <> 'true' or result->'job'->>'status' <> 'queued' then
    raise exception 'chat enqueue failed: %', result;
  end if;
  result := public.enqueue_job(
    input_job_id => '82000000-0000-4000-8000-000000000099',
    input_type => 'chat.generation',
    input_queue => 'ideal_chat',
    input_principal_id => '00000000-0000-4000-8000-000000000001',
    input_auth_class => 'registered',
    input_subject => jsonb_build_object(
      'conversationId', '80000000-0000-4000-8000-000000000001',
      'userMessageId', '81000000-0000-4000-8000-000000000001',
      'assistantMessageId', '81000000-0000-4000-8000-000000000002'
    ),
    input_idempotency_key => 'pg16-chat-intent',
    input_input_hash => repeat('a', 64),
    input_payload => jsonb_build_object('outputKind', 'text')
  );
  if result->>'replayed' <> 'true'
     or result->'job'->>'id' <> '82000000-0000-4000-8000-000000000001' then
    raise exception 'enqueue idempotency replay failed: %', result;
  end if;

  perform public.enqueue_job(
    '82700000-0000-4000-8000-000000000001', 'cleanup.payload', 'ideal_payload',
    '00000000-0000-4000-8000-000000000001', 'registered', '{}'::jsonb,
    'pg16-payload-intent', repeat('7', 64),
    jsonb_build_object('payloadRef', jsonb_build_object(
      'bucket', 'job-payloads',
      'objectKey', '00000000-0000-4000-8000-000000000001/82700000-0000-4000-8000-000000000001/' || repeat('6', 64) || '.json',
      'sha256', repeat('6', 64),
      'bytes', 128,
      'contentType', 'application/json'
    ))
  );

  perform public.enqueue_job(
    '82500000-0000-4000-8000-000000000001', 'chat.title', 'ideal_title',
    '00000000-0000-4000-8000-000000000001', 'registered',
    jsonb_build_object('conversationId', '80000000-0000-4000-8000-000000000001'),
    'pg16-title-intent-1', repeat('2', 64)
  );
  begin
    perform public.enqueue_job(
      '82500000-0000-4000-8000-000000000002', 'chat.title', 'ideal_title',
      '00000000-0000-4000-8000-000000000001', 'registered',
      jsonb_build_object('conversationId', '80000000-0000-4000-8000-000000000001'),
      'pg16-title-intent-2', repeat('3', 64)
    );
    raise exception 'second active title unexpectedly enqueued';
  exception when unique_violation then null;
  end;

  result := public.claim_next_job('pg16-title-worker', array['ideal_title'], 120);
  if result->>'acquired' <> 'true' then
    raise exception 'title job claim failed: %', result;
  end if;
  result := public.finalize_job(
    '82500000-0000-4000-8000-000000000001', 'pg16-title-worker', 1,
    'completed', '{"title":"Database-owned title"}'::jsonb
  );
  if result->>'status' <> 'completed' then
    raise exception 'title job finalize failed: %', result;
  end if;

  perform public.enqueue_job(
    '82600000-0000-4000-8000-000000000001', 'agent.task', 'ideal_agent',
    '00000000-0000-4000-8000-000000000001', 'registered',
    jsonb_build_object(
      'taskId', '80500000-0000-4000-8000-000000000001',
      'repo', 'owner/repo',
      'sessionId', '80600000-0000-4000-8000-000000000001',
      'responseId', '80800000-0000-4000-8000-000000000001',
      'userMessageId', '80700000-0000-4000-8000-000000000001'
    ),
    'pg16-agent-intent-1', repeat('4', 64)
  );
  begin
    perform public.enqueue_job(
      '82600000-0000-4000-8000-000000000002', 'agent.task', 'ideal_agent',
      '00000000-0000-4000-8000-000000000001', 'registered',
      jsonb_build_object(
        'taskId', '80500000-0000-4000-8000-000000000001',
        'repo', 'owner/repo',
        'sessionId', '80600000-0000-4000-8000-000000000001',
        'responseId', '80800000-0000-4000-8000-000000000002',
        'userMessageId', '80700000-0000-4000-8000-000000000001'
      ),
      'pg16-agent-intent-2', repeat('5', 64)
    );
    raise exception 'second active agent task unexpectedly enqueued';
  exception when unique_violation then null;
  end;

  result := public.claim_next_job('pg16-agent-worker', array['ideal_agent'], 120);
  if result->>'acquired' <> 'true' then
    raise exception 'agent job claim failed: %', result;
  end if;
  result := public.finalize_job(
    '82600000-0000-4000-8000-000000000001', 'pg16-agent-worker', 1,
    'completed', '{"content":"durable agent reply","taskStatus":"waiting_for_user","progress":{"published":true}}'::jsonb
  );
  if result->>'status' <> 'completed' then
    raise exception 'agent job finalize failed: %', result;
  end if;

  result := public.claim_next_job('pg16-chat-worker', array['ideal_chat'], 120);
  if result->>'acquired' <> 'true'
     or result->'job'->>'leaseVersion' <> '1' then
    raise exception 'chat claim failed: %', result;
  end if;
  result := public.append_job_events(
    '82000000-0000-4000-8000-000000000001', 'pg16-chat-worker', 1,
    '[{"kind":"model.round.started","idempotencyKey":"pg16-round-1","payload":{"round":1}}]'::jsonb
  );
  if result->>'appended' <> 'true' or result->>'replayed' <> 'false' then
    raise exception 'idempotent event append failed: %', result;
  end if;
  result := public.append_job_events(
    '82000000-0000-4000-8000-000000000001', 'pg16-chat-worker', 1,
    '[{"kind":"model.round.started","idempotencyKey":"pg16-round-1","payload":{"round":1}}]'::jsonb
  );
  if result->>'appended' <> 'true' or result->>'replayed' <> 'true' then
    raise exception 'event append replay duplicated: %', result;
  end if;
  result := public.checkpoint_job(
    '82000000-0000-4000-8000-000000000001', 'pg16-chat-worker', 1,
    'model.round.1', '{"round":1}'::jsonb,
    '{"content":"partial","contentParts":[{"type":"text","text":"partial"}]}'::jsonb,
    true, 'running'
  );
  if result->>'checkpointed' <> 'true' then
    raise exception 'chat checkpoint failed: %', result;
  end if;
  result := public.cancel_job(
    '82000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000001',
    'pg16 cancellation race'
  );
  if result->>'status' <> 'cancelling' then
    raise exception 'live cancellation did not enter cancelling: %', result;
  end if;
  result := public.finalize_job(
    '82000000-0000-4000-8000-000000000001', 'pg16-chat-worker', 1,
    'completed',
    '{"content":"cancelled snapshot","contentParts":[{"type":"text","text":"cancelled snapshot"}]}'::jsonb
  );
  if result->>'status' <> 'cancelled' then
    raise exception 'cancel did not beat reversible completion: %', result;
  end if;
  result := public.finalize_job(
    '82000000-0000-4000-8000-000000000001', 'pg16-chat-worker', 1,
    'completed', '{}'::jsonb
  );
  if result->>'replayed' <> 'true' or result->>'status' <> 'cancelled' then
    raise exception 'terminal replay changed authority: %', result;
  end if;
end;
$$;
reset role;

do $$
begin
  if (select status from public.messages where id = '81000000-0000-4000-8000-000000000002') <> 'terminal'
     or (select generation_id from public.messages where id = '81000000-0000-4000-8000-000000000002')
       <> '82000000-0000-4000-8000-000000000001' then
    raise exception 'message terminal projection failed';
  end if;
  if (select title from public.conversations where id = '80000000-0000-4000-8000-000000000001')
     <> 'Database-owned title' then
    raise exception 'title terminal projection failed';
  end if;
  if (select status from public.agent_tasks where id = '80500000-0000-4000-8000-000000000001')
     <> 'waiting_for_user' then
    raise exception 'agent task terminal projection failed';
  end if;
  if (select content from public.code_messages where id = '80800000-0000-4000-8000-000000000001')
     <> 'durable agent reply' then
    raise exception 'agent message terminal projection failed';
  end if;
  if exists (
    select 1
    from (
      select seq, lag(seq) over (order by seq) as previous_seq
      from public.job_events
      where job_id = '82000000-0000-4000-8000-000000000001'
    ) as ordered
    where previous_seq is not null and seq <> previous_seq + 1
  ) then
    raise exception 'job event sequence contains a gap';
  end if;
end;
$$;

set role service_role;
do $$
declare result jsonb;
begin
  result := public.enqueue_job(
    '83000000-0000-4000-8000-000000000001', 'cleanup.ledger', 'ideal_ledger',
    '00000000-0000-4000-8000-000000000001', 'registered', '{}'::jsonb,
    'pg16-ledger-intent', repeat('b', 64)
  );
  result := public.claim_next_job('pg16-ledger-worker', array['ideal_ledger'], 120);
  result := public.finalize_job(
    '83000000-0000-4000-8000-000000000001', 'pg16-ledger-worker', 1,
    'completed', '{"ok":true}'::jsonb, null, null,
    '[{"idempotencyKey":"pg16-charge-once","reason":"test","weightedTokens":7,"rawTokens":5}]'::jsonb,
    '[{"kind":"test.completed","payload":{"ok":true}}]'::jsonb
  );
  if result->>'status' <> 'completed' then
    raise exception 'ledger finalization failed: %', result;
  end if;

  perform public.enqueue_job(
    '83000000-0000-4000-8000-000000000006', 'cleanup.retry', 'ideal_retry',
    '00000000-0000-4000-8000-000000000001', 'registered', '{}'::jsonb,
    'pg16-retry-intent', repeat('2', 64)
  );
  result := public.claim_next_job('pg16-retry-worker-1', array['ideal_retry'], 120);
  if result->>'acquired' <> 'true' then raise exception 'retry fixture claim failed: %', result; end if;
  result := public.retry_job(
    '83000000-0000-4000-8000-000000000006', 'pg16-retry-worker-1', 1,
    'provider', 'provider_503', 1
  );
  if result->>'retried' <> 'true' or result->>'status' <> 'queued' then
    raise exception 'controlled retry was not scheduled: %', result;
  end if;

  perform public.enqueue_job(
    '83000000-0000-4000-8000-000000000002', 'cleanup.safe', 'ideal_safe',
    '00000000-0000-4000-8000-000000000001', 'registered', '{}'::jsonb,
    'pg16-safe-intent', repeat('c', 64)
  );
  perform public.claim_next_job('pg16-safe-worker-1', array['ideal_safe'], 15);
  perform public.checkpoint_job(
    '83000000-0000-4000-8000-000000000002', 'pg16-safe-worker-1', 1,
    'safe.point', '{}'::jsonb, '{}'::jsonb, true, 'running'
  );

  perform public.enqueue_job(
    '83000000-0000-4000-8000-000000000003', 'cleanup.unsafe', 'ideal_unsafe',
    '00000000-0000-4000-8000-000000000001', 'registered', '{}'::jsonb,
    'pg16-unsafe-intent', repeat('d', 64)
  );
  perform public.claim_next_job('pg16-unsafe-worker-1', array['ideal_unsafe'], 15);
  perform public.checkpoint_job(
    '83000000-0000-4000-8000-000000000003', 'pg16-unsafe-worker-1', 1,
    'unsafe.before', '{}'::jsonb, '{}'::jsonb, true, 'running'
  );
  perform public.record_job_tool_effect(
    '83000000-0000-4000-8000-000000000003', 'pg16-unsafe-worker-1', 1,
    'publish-1', 'publish', repeat('e', 64), 'pg16-publish-once', 'running'
  );
  perform public.record_job_tool_effect(
    '83000000-0000-4000-8000-000000000003', 'pg16-unsafe-worker-1', 1,
    'publish-1', 'publish', repeat('e', 64), 'pg16-publish-once', 'succeeded',
    '{"pullRequest":1}'::jsonb, false
  );
  result := public.retry_job(
    '83000000-0000-4000-8000-000000000003', 'pg16-unsafe-worker-1', 1,
    'provider', 'provider_503', 1
  );
  if result->>'reason' <> 'unsafe_effect' then
    raise exception 'unsafe controlled retry was accepted: %', result;
  end if;

  perform public.enqueue_job(
    '83000000-0000-4000-8000-000000000004', 'cleanup.concurrent', 'ideal_concurrent',
    '00000000-0000-4000-8000-000000000001', 'registered', '{}'::jsonb,
    'pg16-concurrent-intent', repeat('f', 64)
  );
  perform public.enqueue_job(
    '83000000-0000-4000-8000-000000000005', 'cleanup.tenant', 'ideal_tenant',
    '00000000-0000-4000-8000-000000000002', 'registered', '{}'::jsonb,
    'pg16-tenant-intent', repeat('1', 64)
  );
end;
$$;
reset role;

do $$
begin
  if (select count(*) from public.ledger_entries where idempotency_key = 'pg16-charge-once') <> 1
     or (select count(*) from public.job_outbox where dedupe_key = '83000000-0000-4000-8000-000000000001:outbox:1:test.completed') <> 1
     or (select count(*) from public.job_outbox where dedupe_key = '83000000-0000-4000-8000-000000000001:terminal') <> 1 then
    raise exception 'ledger/outbox terminal transaction was not exactly once';
  end if;
  if not exists (
    select 1 from public.job_events
    where job_id = '83000000-0000-4000-8000-000000000006'
      and kind = 'job.retry_scheduled'
  ) or not exists (
    select 1 from public.job_outbox
    where job_id = '83000000-0000-4000-8000-000000000006'
      and topic = 'jobs.ready'
      and dedupe_key like '%:ready:retry:%'
  ) then
    raise exception 'retry event/outbox was not committed atomically';
  end if;
end;
$$;

update public.jobs
set lease_expires_at = clock_timestamp() - interval '1 second'
where id in (
  '83000000-0000-4000-8000-000000000002',
  '83000000-0000-4000-8000-000000000003'
);

set role service_role;
do $$
declare result jsonb;
begin
  result := public.claim_next_job('pg16-safe-worker-2', array['ideal_safe'], 15);
  if result->>'acquired' <> 'true' or result->'job'->>'leaseVersion' <> '2' then
    raise exception 'safe checkpoint was not re-leased: %', result;
  end if;
  result := public.claim_next_job('pg16-unsafe-worker-2', array['ideal_unsafe'], 15);
  if result->>'reason' <> 'stale_lease_unrecoverable'
     or result->'job'->>'status' <> 'failed' then
    raise exception 'unsafe stale effect was replayed: %', result;
  end if;
end;
$$;
reset role;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-4000-8000-000000000001';
do $$
begin
  if exists (
    select 1 from public.jobs
    where principal_id <> '00000000-0000-4000-8000-000000000001'
  ) then
    raise exception 'job RLS exposed another tenant';
  end if;
  begin
    update public.messages
    set content = 'browser overwrite'
    where id = '81000000-0000-4000-8000-000000000002';
    raise exception 'terminal generated message was browser-writable';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset role;
