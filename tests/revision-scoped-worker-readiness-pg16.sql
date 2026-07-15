\set ON_ERROR_STOP on

begin;

delete from public.job_worker_heartbeats;
insert into public.job_worker_heartbeats(
  worker_id, revision, queues, capacity, draining, started_at, heartbeat_at
) values
  ('revision-a-chat',   'aaaaaaaaaaaa', array['chat'],   2, false, clock_timestamp() - interval '1 minute', clock_timestamp()),
  ('revision-a-media',  'aaaaaaaaaaaa', array['media'],  1, false, clock_timestamp() - interval '1 minute', clock_timestamp()),
  ('revision-a-title',  'aaaaaaaaaaaa', array['title'],  1, false, clock_timestamp() - interval '1 minute', clock_timestamp()),
  ('revision-a-agent',  'aaaaaaaaaaaa', array['agent'],  1, false, clock_timestamp() - interval '1 minute', clock_timestamp()),
  ('revision-a-outbox', 'aaaaaaaaaaaa', array['outbox'], 1, false, clock_timestamp() - interval '1 minute', clock_timestamp()),
  ('revision-a-stale',  'aaaaaaaaaaaa', array['chat'],   9, false, clock_timestamp() - interval '2 minutes', clock_timestamp() - interval '1 minute'),
  ('revision-a-drain',  'aaaaaaaaaaaa', array['chat'],  50, true,  clock_timestamp() - interval '1 minute', clock_timestamp()),
  ('revision-b-active', 'bbbbbbbbbbbb', array['chat','media','title','agent','outbox'], 200, false, clock_timestamp() - interval '1 minute', clock_timestamp()),
  ('revision-b-stale',  'bbbbbbbbbbbb', array['chat'], 100, false, clock_timestamp() - interval '2 minutes', clock_timestamp() - interval '1 minute'),
  ('revision-b-drain',  'bbbbbbbbbbbb', array['chat'], 100, true, clock_timestamp() - interval '1 minute', clock_timestamp());

set role service_role;
do $$
declare
  result jsonb;
begin
  if not public.runtime_healthcheck_v12() then
    raise exception 'revision-scoped structural readiness failed';
  end if;

  result := public.read_job_worker_readiness_v2(
    array['chat','media','title','agent','outbox'], 20, 'aaaaaaaaaaaa'
  );
  if result->>'ready' <> 'true'
     or result->>'activeWorkers' <> '5'
     or result->>'totalCapacity' <> '6'
     or result->>'staleWorkers' <> '1'
     or result->>'drainingWorkers' <> '1'
     or jsonb_array_length(result->'queues') <> 5
     or exists (
       select 1
       from jsonb_array_elements(result->'queues') as sample(value)
       join (values
         ('chat', 2), ('media', 1), ('title', 1), ('agent', 1), ('outbox', 1)
       ) as expected(queue, capacity)
         on expected.queue = sample.value->>'queue'
       where sample.value->>'ready' <> 'true'
          or (sample.value->>'activeWorkers')::integer <> 1
          or (sample.value->>'totalCapacity')::integer <> expected.capacity
     ) then
    raise exception 'current revision capacity was inflated or incomplete: %', result;
  end if;

  result := public.read_job_worker_readiness_v2(
    array['chat','media','title','agent','outbox'], 20, 'bbbbbbbbbbbb'
  );
  if result->>'ready' <> 'true'
     or result->>'activeWorkers' <> '1'
     or result->>'totalCapacity' <> '200'
     or result->>'staleWorkers' <> '1'
     or result->>'drainingWorkers' <> '1' then
    raise exception 'other revision metrics were not independently scoped: %', result;
  end if;

  perform public.mark_job_worker_draining('revision-a-agent');
  result := public.read_job_worker_readiness_v2(
    array['chat','media','title','agent','outbox'], 20, 'aaaaaaaaaaaa'
  );
  if result->>'ready' <> 'false'
     or result->'missingQueues' <> '["agent"]'::jsonb
     or result->>'activeWorkers' <> '4'
     or result->>'totalCapacity' <> '5' then
    raise exception 'another revision satisfied missing current capacity: %', result;
  end if;

  begin
    perform public.read_job_worker_readiness_v2(
      array['chat','media','title','agent','outbox'], 20, null
    );
    raise exception 'null revision was accepted';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.read_job_worker_readiness_v2(
      array['chat','media','title','agent','outbox'], 20, ''
    );
    raise exception 'empty revision was accepted';
  exception when invalid_parameter_value then null;
  end;
end;
$$;
reset role;

savepoint missing_terminal_projection_contract;
drop trigger jobs_project_terminal on public.jobs;
set role service_role;
do $$
begin
  if public.runtime_healthcheck_v12() then
    raise exception 'v12 accepted a database without the terminal projection trigger';
  end if;
end;
$$;
reset role;
rollback to savepoint missing_terminal_projection_contract;

savepoint missing_tenant_integrity_contract;
alter table public.job_events drop constraint job_events_tenant_job_fkey;
set role service_role;
do $$
begin
  if public.runtime_healthcheck_v12() then
    raise exception 'v12 accepted a database without a validated tenant ownership FK';
  end if;
end;
$$;
reset role;
rollback to savepoint missing_tenant_integrity_contract;

set role authenticated;
do $$
begin
  if has_function_privilege(
    'authenticated',
    'public.read_job_worker_readiness_v2(text[],integer,text)',
    'EXECUTE'
  ) or has_function_privilege(
    'authenticated', 'public.runtime_healthcheck_v12()', 'EXECUTE'
  ) then
    raise exception 'revision-scoped worker authority leaked to browser role';
  end if;
end;
$$;
reset role;

rollback;
