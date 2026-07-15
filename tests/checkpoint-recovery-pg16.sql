\set ON_ERROR_STOP on

set role service_role;
do $$
declare result jsonb;
begin
  perform public.enqueue_job(
    '89600000-0000-4000-8000-000000000001', 'cleanup.checkpoint_safe', 'checkpoint_safe',
    '00000000-0000-4000-8000-000000000001', 'registered', '{}'::jsonb,
    'checkpoint-safe-intent', repeat('1', 64)
  );
  result := public.claim_next_job('checkpoint-safe-worker-1', array['checkpoint_safe'], 15);
  if result->>'acquired' <> 'true' then raise exception 'safe fixture claim failed: %', result; end if;
  perform public.checkpoint_job(
    '89600000-0000-4000-8000-000000000001', 'checkpoint-safe-worker-1', 1,
    'model.round.1', '{"schemaVersion":1,"trajectory":[]}'::jsonb,
    '{"totalTokens":10}'::jsonb, true, 'running'
  );

  perform public.enqueue_job(
    '89600000-0000-4000-8000-000000000002', 'cleanup.checkpoint_unsafe', 'checkpoint_unsafe',
    '00000000-0000-4000-8000-000000000001', 'registered', '{}'::jsonb,
    'checkpoint-unsafe-intent', repeat('2', 64)
  );
  result := public.claim_next_job('checkpoint-unsafe-worker-1', array['checkpoint_unsafe'], 15);
  if result->>'acquired' <> 'true' then raise exception 'unsafe fixture claim failed: %', result; end if;
  perform public.checkpoint_job(
    '89600000-0000-4000-8000-000000000002', 'checkpoint-unsafe-worker-1', 1,
    'model.round.oversized', '{"schemaVersion":1,"oversized":true}'::jsonb,
    '{"totalTokens":10}'::jsonb, false, 'running'
  );
end;
$$;
reset role;

update public.jobs
set lease_expires_at = clock_timestamp() - interval '1 second'
where id in (
  '89600000-0000-4000-8000-000000000001',
  '89600000-0000-4000-8000-000000000002'
);

set role service_role;
do $$
declare result jsonb;
begin
  result := public.claim_next_job('checkpoint-safe-worker-2', array['checkpoint_safe'], 15);
  if result->>'acquired' <> 'true'
     or result->'job'->>'leaseVersion' <> '2'
     or result->'job'->'checkpoint'->>'resumable' <> 'true'
     or result->'job'->'checkpoint'->'data'->>'schemaVersion' <> '1' then
    raise exception 'resumable checkpoint was not restored with its envelope: %', result;
  end if;

  result := public.claim_next_job('checkpoint-unsafe-worker-2', array['checkpoint_unsafe'], 15);
  if result->>'acquired' <> 'false'
     or result->>'reason' <> 'stale_lease_unrecoverable'
     or result->'job'->>'status' <> 'failed' then
    raise exception 'non-resumable checkpoint was reclaimed: %', result;
  end if;

  result := public.append_job_events(
    '89600000-0000-4000-8000-000000000001', 'checkpoint-safe-worker-1', 1,
    '[{"kind":"job.progress","payload":{}}]'::jsonb
  );
  if result->>'appended' <> 'false' then
    raise exception 'old checkpoint fence appended after recovery: %', result;
  end if;
end;
$$;
reset role;
