\set ON_ERROR_STOP on

-- Deterministic operational states spanning each bounded metric family.
delete from public.job_assets where job_id::text like '89000000-0000-4000-8000-%';
delete from public.job_outbox where job_id::text like '89000000-0000-4000-8000-%';
delete from public.jobs where id::text like '89000000-0000-4000-8000-%';

do $$
declare
  v_now timestamptz := clock_timestamp();
begin
  insert into public.jobs(
    id, type, queue, principal_id, auth_class, subject, idempotency_key,
    input_hash, payload, status, attempt, max_attempts, available_at,
    lease_version, created_at, updated_at
  ) values (
    '89000000-0000-4000-8000-000000000001', 'chat.generation', 'chat',
    '00000000-0000-4000-8000-000000000001', 'registered', '{}'::jsonb,
    'observability-chat-retry', repeat('1', 64), '{"outputKind":"text"}'::jsonb,
    'queued', 1, 3, v_now - interval '10 seconds', 1,
    v_now - interval '10 seconds', v_now - interval '10 seconds'
  );

  insert into public.jobs(
    id, type, queue, principal_id, auth_class, subject, idempotency_key,
    input_hash, payload, status, attempt, max_attempts, available_at,
    lease_version, created_at, updated_at, started_at, terminal_at
  ) values (
    '89000000-0000-4000-8000-000000000002', 'chat.title', 'title',
    '00000000-0000-4000-8000-000000000001', 'registered', '{}'::jsonb,
    'observability-title-good', repeat('2', 64), '{}'::jsonb,
    'completed', 1, 3, v_now - interval '60 seconds', 1,
    v_now - interval '60 seconds', v_now - interval '58 seconds',
    v_now - interval '59 seconds', v_now - interval '58 seconds'
  );

  insert into public.jobs(
    id, type, queue, principal_id, auth_class, subject, idempotency_key,
    input_hash, payload, status, attempt, max_attempts, available_at,
    lease_version, cancel_requested_at, created_at, updated_at, started_at, terminal_at
  ) values (
    '89000000-0000-4000-8000-000000000003', 'agent.task', 'agent',
    '00000000-0000-4000-8000-000000000001', 'registered', '{}'::jsonb,
    'observability-cancel-good', repeat('3', 64), '{}'::jsonb,
    'cancelled', 1, 3, v_now - interval '30 seconds', 1,
    v_now - interval '10 seconds', v_now - interval '30 seconds',
    v_now - interval '8 seconds', v_now - interval '29 seconds',
    v_now - interval '8 seconds'
  );

  insert into public.jobs(
    id, type, queue, principal_id, auth_class, subject, idempotency_key,
    input_hash, payload, status, attempt, max_attempts, available_at,
    lease_owner, lease_version, lease_expires_at, cancel_requested_at,
    created_at, updated_at, started_at
  ) values (
    '89000000-0000-4000-8000-000000000004', 'agent.task', 'agent',
    '00000000-0000-4000-8000-000000000001', 'registered', '{}'::jsonb,
    'observability-cancel-breach', repeat('4', 64), '{}'::jsonb,
    'cancelling', 1, 3, v_now - interval '30 seconds',
    'observability-worker', 1, v_now + interval '120 seconds',
    v_now - interval '10 seconds', v_now - interval '30 seconds',
    v_now, v_now - interval '29 seconds'
  );

  insert into public.jobs(
    id, type, queue, principal_id, auth_class, subject, idempotency_key,
    input_hash, payload, status, attempt, max_attempts, available_at,
    lease_version, error_class, error_code, created_at, updated_at,
    started_at, terminal_at
  ) values (
    '89000000-0000-4000-8000-000000000005', 'cleanup.poison', 'cleanup',
    '00000000-0000-4000-8000-000000000001', 'registered', '{}'::jsonb,
    'observability-poison', repeat('5', 64), '{}'::jsonb,
    'failed', 3, 3, v_now - interval '30 seconds', 3,
    'internal', 'job_attempts_exhausted', v_now - interval '30 seconds',
    v_now - interval '5 seconds', v_now - interval '29 seconds',
    v_now - interval '5 seconds'
  );

  insert into public.jobs(
    id, type, queue, principal_id, auth_class, subject, idempotency_key,
    input_hash, payload, status, attempt, max_attempts, available_at,
    lease_owner, lease_version, lease_expires_at, created_at, updated_at, started_at
  ) values (
    '89000000-0000-4000-8000-000000000006', 'tool.invoke', 'tool',
    '00000000-0000-4000-8000-000000000001', 'registered', '{}'::jsonb,
    'observability-expired-lease', repeat('6', 64), '{}'::jsonb,
    'running', 1, 3, v_now - interval '30 seconds',
    'observability-worker', 1, v_now - interval '5 seconds',
    v_now - interval '30 seconds', v_now - interval '5 seconds',
    v_now - interval '29 seconds'
  );

  insert into public.job_outbox(
    job_id, principal_id, topic, dedupe_key, payload, status, attempts,
    available_at, max_attempts, created_at, updated_at
  ) values (
    '89000000-0000-4000-8000-000000000005',
    '00000000-0000-4000-8000-000000000001', 'assets.cleanup',
    'observability-dead-cleanup', '{}'::jsonb, 'dead', 10,
    v_now - interval '20 minutes', 10,
    v_now - interval '20 minutes', v_now - interval '20 minutes'
  );
  insert into public.job_outbox(
    job_id, principal_id, topic, dedupe_key, payload, status, attempts,
    available_at, locked_by, lock_expires_at, lock_version, max_attempts,
    created_at, updated_at
  ) values (
    '89000000-0000-4000-8000-000000000006',
    '00000000-0000-4000-8000-000000000001', 'jobs.ready',
    'observability-expired-outbox', '{}'::jsonb, 'publishing', 2,
    v_now - interval '10 minutes', 'observability-outbox-worker',
    v_now - interval '5 seconds', 2, 10,
    v_now - interval '10 minutes', v_now - interval '5 seconds'
  );

  insert into public.job_assets(
    job_id, principal_id, bucket, object_key, media_type, mime_type,
    bytes, state, lease_version, created_at, updated_at
  ) values (
    '89000000-0000-4000-8000-000000000005',
    '00000000-0000-4000-8000-000000000001', 'generated-media',
    'observability/dead-orphan.png', 'image', 'image/png',
    128, 'uploaded', 3, v_now - interval '20 minutes', v_now - interval '20 minutes'
  ), (
    '89000000-0000-4000-8000-000000000003',
    '00000000-0000-4000-8000-000000000001', 'generated-media',
    'observability/pending.png', 'image', 'image/png',
    128, 'deleting', 1, v_now, v_now
  ), (
    '89000000-0000-4000-8000-000000000006',
    '00000000-0000-4000-8000-000000000001', 'generated-media',
    'observability/active-upload.png', 'image', 'image/png',
    128, 'uploaded', 1, v_now, v_now
  );
end;
$$;

do $$
begin
  if has_function_privilege(
    'authenticated', 'public.read_job_observability_v1(integer)', 'EXECUTE'
  ) or has_function_privilege(
    'anon', 'public.read_job_observability_v1(integer)', 'EXECUTE'
  ) or not has_function_privilege(
    'service_role', 'public.read_job_observability_v1(integer)', 'EXECUTE'
  ) then
    raise exception 'observability RPC privilege boundary is invalid';
  end if;
  if has_function_privilege(
    'service_role', 'public.job_observability_type(text,text,jsonb)', 'EXECUTE'
  ) then
    raise exception 'internal metric classifier leaked to service role';
  end if;
  if has_table_privilege(
    'service_role', 'public.job_observability_terminal_counts', 'SELECT'
  ) or has_table_privilege(
    'authenticated', 'public.job_observability_terminal_counts', 'SELECT'
  ) then
    raise exception 'terminal rollup table leaked outside the definer RPC';
  end if;
end;
$$;

set role authenticated;
do $$
begin
  begin
    perform public.read_job_observability_v1(3600);
    raise exception 'authenticated observability read unexpectedly succeeded';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset role;

-- Active uploads are normal work-in-progress, not cleanup backlog. Compare the
-- RPC exactly with the intended terminal/deleting predicate so future edits
-- cannot silently turn every media generation into a cleanup alert.
do $$
declare
  metrics jsonb := public.read_job_observability_v1(3600);
  expected_pending bigint;
begin
  select count(*) into expected_pending
  from public.job_assets asset
  join public.jobs job on job.id = asset.job_id
    and job.principal_id = asset.principal_id
  where asset.state = 'deleting'
    or (
      asset.state in ('reserved', 'uploaded')
      and job.status in ('completed', 'failed', 'cancelled')
    );
  if (metrics->'assets'->>'cleanupPending')::bigint <> expected_pending then
    raise exception 'active asset was misreported as cleanup pending: %, expected %',
      metrics->'assets', expected_pending;
  end if;
end;
$$;

set role service_role;
do $$
declare
  metrics jsonb := public.read_job_observability_v1(3600);
  agent_sample jsonb;
  chat_sample jsonb;
  cleanup_sample jsonb;
  tool_sample jsonb;
begin
  if metrics->>'schemaVersion' <> '1'
     or metrics->>'windowSeconds' <> '3600'
     or jsonb_array_length(metrics->'jobTypes') <> 8 then
    raise exception 'observability contract mismatch: %', metrics;
  end if;
  if exists (
    select 1 from jsonb_array_elements(metrics->'jobTypes') sample
    where sample->>'jobType' not in (
      'chat_generation', 'media_image', 'media_video', 'agent_task',
      'tool', 'title', 'cleanup', 'other'
    )
  ) then
    raise exception 'unbounded job type escaped observability contract: %', metrics;
  end if;
  if metrics::text like '%89000000-%'
     or metrics::text like '%00000000-0000-4000-8000-000000000001%'
     or metrics ? 'jobId' or metrics ? 'principalId' then
    raise exception 'high-cardinality identifier leaked: %', metrics;
  end if;

  select value into agent_sample from jsonb_array_elements(metrics->'jobTypes')
  where value->>'jobType' = 'agent_task';
  select value into chat_sample from jsonb_array_elements(metrics->'jobTypes')
  where value->>'jobType' = 'chat_generation';
  select value into cleanup_sample from jsonb_array_elements(metrics->'jobTypes')
  where value->>'jobType' = 'cleanup';
  select value into tool_sample from jsonb_array_elements(metrics->'jobTypes')
  where value->>'jobType' = 'tool';

  if (chat_sample->>'queueDepth')::bigint < 1
     or (chat_sample->>'retryWaiting')::bigint < 1
     or (chat_sample->'enqueueStarted'->>'eligible')::bigint < 1 then
    raise exception 'queue/retry/enqueue SLO aggregation failed: %', chat_sample;
  end if;
  if (agent_sample->'cancelTerminal'->>'eligible')::bigint < 2
     or (agent_sample->'cancelTerminal'->>'good')::bigint < 1
     or (agent_sample->'cancelTerminal'->>'good')::bigint
        >= (agent_sample->'cancelTerminal'->>'eligible')::bigint then
    raise exception 'cancellation SLO aggregation failed: %', agent_sample;
  end if;
  if (cleanup_sample->>'poison')::bigint < 1
     or (cleanup_sample->'terminalTotal'->>'failed')::bigint < 1
     or (tool_sample->>'leaseExpired')::bigint < 1 then
    raise exception 'lease/poison aggregation failed: %, %', cleanup_sample, tool_sample;
  end if;
  if (metrics->'outbox'->>'dead')::bigint < 1
     or (metrics->'outbox'->>'expiredLeases')::bigint < 1
     or (metrics->'outbox'->>'retrying')::bigint < 1 then
    raise exception 'outbox aggregation failed: %', metrics->'outbox';
  end if;
  if (metrics->'assets'->>'cleanupPending')::bigint < 2
     or (metrics->'assets'->>'cleanupDead')::bigint < 1
     or (metrics->'assets'->>'cleanupOrphan')::bigint < 1 then
    raise exception 'asset convergence aggregation failed: %', metrics->'assets';
  end if;

  begin
    perform public.read_job_observability_v1(299);
    raise exception 'invalid observability window unexpectedly succeeded';
  exception when sqlstate '22023' then null;
  end;
end;
$$;
reset role;
