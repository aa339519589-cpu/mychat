\set ON_ERROR_STOP on

insert into public.job_outbox(
  id, job_id, principal_id, topic, dedupe_key, payload, status,
  attempts, max_attempts, lock_version, replay_count, max_redrives,
  last_error, available_at
) values (
  '84d00000-0000-4000-8000-000000000001',
  '84000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000001',
  'tests.redrive', 'pg16-outbox-redrive', '{}'::jsonb, 'dead',
  10, 10, 7, 0, 2, 'provider_unavailable', clock_timestamp()
);

set role service_role;
do $$
declare
  result jsonb;
begin
  result := public.redrive_job_outbox(
    '84d00000-0000-4000-8000-000000000001', 7,
    'pg16-redrive-request-0001', 'pg16-operator', 'provider recovered', 0
  );
  if result->>'redriven' <> 'true'
     or result->>'replayed' <> 'false'
     or result->>'status' <> 'pending'
     or result->>'lockVersion' <> '8'
     or result->>'replayCount' <> '1' then
    raise exception 'initial outbox redrive failed: %', result;
  end if;

  result := public.redrive_job_outbox(
    '84d00000-0000-4000-8000-000000000001', 7,
    'pg16-redrive-request-0001', 'pg16-operator', 'provider recovered', 0
  );
  if result->>'redriven' <> 'true' or result->>'replayed' <> 'true' then
    raise exception 'idempotent outbox redrive replay failed: %', result;
  end if;

  result := public.redrive_job_outbox(
    '84d00000-0000-4000-8000-000000000001', 7,
    'pg16-redrive-request-0001', 'pg16-operator', 'changed request', 0
  );
  if result->>'reason' <> 'idempotency_conflict' then
    raise exception 'redrive key reuse was not rejected: %', result;
  end if;

  result := public.redrive_job_outbox(
    '84d00000-0000-4000-8000-000000000001', 7,
    'pg16-redrive-request-stale', 'pg16-operator', 'stale request', 0
  );
  if result->>'reason' <> 'stale_lock' then
    raise exception 'stale redrive generation was accepted: %', result;
  end if;

  result := public.redrive_job_outbox(
    '84d00000-0000-4000-8000-000000000001', 8,
    'pg16-redrive-request-live1', 'pg16-operator', 'row is not dead', 0
  );
  if result->>'reason' <> 'not_dead' then
    raise exception 'non-dead outbox row was redriven: %', result;
  end if;

  result := public.complete_job_outbox(
    '84d00000-0000-4000-8000-000000000001', 'old-worker', 7, true
  );
  if result->>'reason' <> 'stale_lock' then
    raise exception 'pre-redrive worker crossed the generation fence: %', result;
  end if;
end;
$$;
reset role;

do $$
begin
  if (select attempts from public.job_outbox
      where id = '84d00000-0000-4000-8000-000000000001') <> 0
     or (select last_error from public.job_outbox
         where id = '84d00000-0000-4000-8000-000000000001') is not null
     or (select count(*) from public.audit_log
         where resource_id = '84d00000-0000-4000-8000-000000000001'
           and action = 'outbox.redriven') <> 1 then
    raise exception 'redrive reset or exactly-once audit invariant failed';
  end if;

  update public.job_outbox
  set status = 'dead', attempts = max_attempts, last_error = 'still_poison'
  where id = '84d00000-0000-4000-8000-000000000001';
end;
$$;

set role service_role;
do $$
declare
  result jsonb;
begin
  result := public.redrive_job_outbox(
    '84d00000-0000-4000-8000-000000000001', 8,
    'pg16-redrive-request-0002', 'pg16-operator', 'second recovery', 1
  );
  if result->>'redriven' <> 'true'
     or result->>'lockVersion' <> '9'
     or result->>'replayCount' <> '2' then
    raise exception 'second bounded redrive failed: %', result;
  end if;

  result := public.redrive_job_outbox(
    '84d00000-0000-4000-8000-000000000001', 7,
    'pg16-redrive-request-0001', 'pg16-operator', 'provider recovered', 0
  );
  if result->>'redriven' <> 'true'
     or result->>'replayed' <> 'true'
     or result->>'lockVersion' <> '8'
     or result->>'replayCount' <> '1' then
    raise exception 'durable historical idempotency receipt failed: %', result;
  end if;
end;
$$;
reset role;

update public.job_outbox
set status = 'dead', attempts = max_attempts, last_error = 'permanent_poison'
where id = '84d00000-0000-4000-8000-000000000001';

set role service_role;
do $$
declare
  result jsonb;
begin
  result := public.redrive_job_outbox(
    '84d00000-0000-4000-8000-000000000001', 9,
    'pg16-redrive-request-0003', 'pg16-operator', 'limit must hold', 0
  );
  if result->>'reason' <> 'redrive_limit'
     or result->>'replayCount' <> '2'
     or result->>'maxRedrives' <> '2' then
    raise exception 'redrive limit was bypassed: %', result;
  end if;
end;
$$;
reset role;

do $$
begin
  if (select count(*) from public.audit_log
      where resource_id = '84d00000-0000-4000-8000-000000000001'
        and action = 'outbox.redriven') <> 2 then
    raise exception 'redrive audit was missing or duplicated';
  end if;
end;
$$;

set role authenticated;
do $$
begin
  begin
    perform public.redrive_job_outbox(
      '84d00000-0000-4000-8000-000000000001', 9,
      'pg16-redrive-request-deny', 'browser', 'must be denied', 0
    );
    raise exception 'authenticated role redrove the service outbox';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset role;

-- This row is intentionally left dead for the shell verifier's two-session
-- CAS race. Exactly one request may transition it to pending.
insert into public.job_outbox(
  id, job_id, principal_id, topic, dedupe_key, payload, status,
  attempts, max_attempts, lock_version, replay_count, max_redrives,
  last_error, available_at
) values (
  '84d00000-0000-4000-8000-000000000002',
  '84000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000001',
  'tests.redrive', 'pg16-outbox-redrive-race', '{}'::jsonb, 'dead',
  10, 10, 11, 0, 2, 'transient_poison', clock_timestamp()
);
