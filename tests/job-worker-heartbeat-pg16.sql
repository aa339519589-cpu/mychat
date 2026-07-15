\set ON_ERROR_STOP on

set role service_role;
do $$
declare result jsonb;
begin
  if not public.runtime_healthcheck_v6() then
    raise exception 'worker heartbeat structural readiness failed';
  end if;
  result := public.read_job_worker_readiness_v1();
  if result->>'ready' <> 'false' then
    raise exception 'empty worker fleet reported ready: %', result;
  end if;

  result := public.heartbeat_job_worker(
    'pg16-worker-all', 'abcdef012345', array['chat','media','title','agent','outbox'],
    6, clock_timestamp() - interval '1 minute', false
  );
  if result->>'accepted' <> 'true' then raise exception 'heartbeat rejected: %', result; end if;
  result := public.read_job_worker_readiness_v1();
  if result->>'ready' <> 'true'
     or result->>'activeWorkers' <> '1'
     or result->>'totalCapacity' <> '6'
     or result->>'staleWorkers' <> '0'
     or result->>'drainingWorkers' <> '0'
     or jsonb_array_length(result->'queues') <> 5
     or exists (
       select 1 from jsonb_array_elements(result->'queues') as queue_sample
       where queue_sample->>'ready' <> 'true'
          or (queue_sample->>'activeWorkers')::integer <> 1
          or (queue_sample->>'freshestHeartbeatAgeSeconds')::numeric < 0
     ) then
    raise exception 'complete worker coverage not ready: %', result;
  end if;

  result := public.mark_job_worker_draining('pg16-worker-all');
  if result->>'accepted' <> 'true' then raise exception 'draining marker rejected: %', result; end if;
  result := public.read_job_worker_readiness_v1();
  if result->>'ready' <> 'false' then raise exception 'draining worker remained ready: %', result; end if;

  perform public.heartbeat_job_worker(
    'pg16-worker-chat', 'abcdef012345', array['chat','title','outbox'], 3,
    clock_timestamp(), false
  );
  perform public.heartbeat_job_worker(
    'pg16-worker-heavy', 'abcdef012345', array['media','agent'], 2,
    clock_timestamp(), false
  );
  result := public.read_job_worker_readiness_v1();
  if result->>'ready' <> 'true'
     or result->>'activeWorkers' <> '2'
     or result->>'totalCapacity' <> '5' then
    raise exception 'split queue coverage not ready: %', result;
  end if;
end;
$$;
reset role;

set role authenticated;
do $$
begin
  if has_table_privilege('authenticated', 'public.job_worker_heartbeats', 'SELECT')
     or has_function_privilege(
       'authenticated',
       'public.heartbeat_job_worker(text,text,text[],integer,timestamptz,boolean)',
       'EXECUTE'
     )
     or has_function_privilege(
       'authenticated', 'public.read_job_worker_readiness_v1(text[],integer)', 'EXECUTE'
     ) then
    raise exception 'worker presence authority leaked to browser role';
  end if;
end;
$$;
reset role;
