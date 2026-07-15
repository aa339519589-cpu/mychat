\set ON_ERROR_STOP on

do $$
begin
  if not public.runtime_healthcheck_v11() then
    raise exception 'stream and lifecycle readiness failed';
  end if;
  if (select file_size_limit from storage.buckets where id = 'job-payloads') <> 8388608 then
    raise exception 'job payload bucket was not bounded to 8 MiB';
  end if;
  if not exists (
    select 1 from public.job_payload_assets
    where job_id = '82700000-0000-4000-8000-000000000001'
      and bytes = 128 and state = 'active'
  ) then
    raise exception 'legacy payload reference was not backfilled';
  end if;
  if not exists (
    select 1 from public.project_files
    where id = '96200000-0000-4000-8000-000000000002'
  ) or not exists (
    select 1 from public.messages
    where id = '96200000-0000-4000-8000-000000000003'
  ) or not exists (
    select 1 from public.job_payload_assets
    where job_id = '96200000-0000-4000-8000-000000000004'
      and bytes = 64 and state = 'active'
  ) then
    raise exception 'rolling cutover lost an in-flight old-version write';
  end if;
  if not exists (
    select 1
    from public.tenant_resource_usage as usage
    where usage.principal_id = '00000000-0000-4000-8000-000000000001'
      and usage.project_file_count = (
        select count(*) from public.project_files
        where user_id = usage.principal_id
      )
      and usage.project_file_bytes = (
        select coalesce(sum(octet_length(coalesce(content, ''))), 0)
        from public.project_files where user_id = usage.principal_id
      )
      and usage.message_count = (
        select count(*) from public.messages where user_id = usage.principal_id
      )
      and usage.message_bytes = (
        select coalesce(sum(
          octet_length(coalesce(content, '')) + octet_length(coalesce(thinking, ''))
          + octet_length(coalesce(content_parts, '[]'::jsonb)::text)
          + octet_length(coalesce(thinking_parts, '[]'::jsonb)::text)
          + octet_length(coalesce(images, 'null'::jsonb)::text)
        ), 0) from public.messages where user_id = usage.principal_id
      )
      and usage.payload_count = (
        select count(*) from public.job_payload_assets
        where principal_id = usage.principal_id and state <> 'deleted'
      )
      and usage.payload_bytes = (
        select coalesce(sum(bytes), 0) from public.job_payload_assets
        where principal_id = usage.principal_id and state <> 'deleted'
      )
  ) then
    raise exception 'rolling cutover resource reconciliation is not authoritative';
  end if;
end;
$$;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-4000-8000-000000000001';
do $$
begin
  begin
    perform public.acquire_job_event_stream(
      '96000000-0000-4000-8000-000000000099',
      '00000000-0000-4000-8000-000000000001',
      '82700000-0000-4000-8000-000000000001', repeat('a', 64)
    );
    raise exception 'authenticated role acquired an infrastructure stream lease';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset role;

set role service_role;
do $$
declare
  job_ids uuid[] := array[
    '82000000-0000-4000-8000-000000000001'::uuid,
    '82500000-0000-4000-8000-000000000001'::uuid,
    '82600000-0000-4000-8000-000000000001'::uuid,
    '82700000-0000-4000-8000-000000000001'::uuid,
    '89800000-0000-4000-8000-000000000001'::uuid
  ];
  stream_ids uuid[] := array[
    '96000000-0000-4000-8000-000000000001'::uuid,
    '96000000-0000-4000-8000-000000000002'::uuid,
    '96000000-0000-4000-8000-000000000003'::uuid,
    '96000000-0000-4000-8000-000000000004'::uuid,
    '96000000-0000-4000-8000-000000000005'::uuid
  ];
  result jsonb;
  i integer;
begin
  for i in 1..4 loop
    result := public.acquire_job_event_stream(
      stream_ids[i], '00000000-0000-4000-8000-000000000001', job_ids[i],
      repeat('a', 64), 45, 900
    );
    if result->>'acquired' <> 'true' then
      raise exception 'stream admission % failed: %', i, result;
    end if;
  end loop;
  result := public.acquire_job_event_stream(
    stream_ids[5], '00000000-0000-4000-8000-000000000001', job_ids[5],
    repeat('b', 64), 45, 900
  );
  if result->>'acquired' <> 'false' or result->>'reason' <> 'capacity' then
    raise exception 'principal stream capacity was not exact: %', result;
  end if;

  result := public.renew_job_event_stream(stream_ids[1], 45);
  if result->>'renewed' <> 'true' then raise exception 'stream renewal failed: %', result; end if;
  perform public.release_job_event_stream(stream_ids[1]);
  result := public.acquire_job_event_stream(
    stream_ids[5], '00000000-0000-4000-8000-000000000001', job_ids[5],
    repeat('b', 64), 45, 900
  );
  if result->>'acquired' <> 'true' then
    raise exception 'released stream capacity was not reusable: %', result;
  end if;
end;
$$;
reset role;

-- Exact aggregate quotas reject growth atomically without corrupting the
-- authoritative counters, and per-row limits reject oversized context rows.
do $$
begin
  begin
    perform public.adjust_tenant_resource_usage(
      '00000000-0000-4000-8000-000000000001', 0, 67108865
    );
    raise exception 'aggregate project byte quota was bypassed';
  exception when sqlstate '54000' then null;
  end;
  begin
    insert into public.messages(
      id, conversation_id, user_id, role, content
    ) values (
      '96000000-0000-4000-8000-000000000011',
      '80000000-0000-4000-8000-000000000002',
      '00000000-0000-4000-8000-000000000001', 'user', repeat('x', 2097153)
    );
    raise exception 'oversized message was accepted';
  exception when sqlstate '54000' then null;
  end;
end;
$$;

-- Finalization atomically creates a delayed cleanup intent. The fixture moves
-- only its clock forward, then exercises the same fenced prepare/finish/publish
-- protocol used by the Storage worker.
set role service_role;
do $$
declare result jsonb;
begin
  result := public.claim_next_job('payload-lifecycle-worker', array['ideal_payload'], 120);
  if result->>'acquired' <> 'true' then raise exception 'payload job claim failed: %', result; end if;
  result := public.finalize_job(
    '82700000-0000-4000-8000-000000000001',
    'payload-lifecycle-worker',
    (result->'job'->>'leaseVersion')::bigint,
    'completed', '{}'::jsonb
  );
  if result->>'status' <> 'completed' then raise exception 'payload finalization failed: %', result; end if;
end;
$$;
reset role;

update public.job_payload_assets
set retain_until = clock_timestamp() - interval '1 second',
    updated_at = clock_timestamp() - interval '1 second'
where job_id = '82700000-0000-4000-8000-000000000001';
update public.job_outbox
set available_at = clock_timestamp() - interval '1 second'
where job_id = '82700000-0000-4000-8000-000000000001'
  and topic = 'payloads.cleanup';

set role service_role;
do $$
declare
  claim jsonb;
  prepared jsonb;
  finished jsonb;
  completed jsonb;
  outbox_id uuid;
  lock_version bigint;
begin
  claim := public.claim_job_outbox('payload-cleanup-worker', array['payloads.cleanup'], 60);
  if claim->>'acquired' <> 'true' then raise exception 'payload cleanup claim failed: %', claim; end if;
  outbox_id := (claim->'message'->>'id')::uuid;
  lock_version := (claim->'message'->>'lockVersion')::bigint;
  prepared := public.prepare_job_payload_cleanup(outbox_id, 'payload-cleanup-worker', lock_version);
  if prepared->>'prepared' <> 'true'
     or prepared->>'objectKey' not like '00000000-0000-4000-8000-000000000001/%' then
    raise exception 'payload cleanup preparation failed: %', prepared;
  end if;
  finished := public.finish_job_payload_cleanup(
    outbox_id, 'payload-cleanup-worker', lock_version, prepared->>'objectKey'
  );
  if finished->>'finished' <> 'true' then raise exception 'payload cleanup finish failed: %', finished; end if;
  completed := public.complete_job_outbox(
    outbox_id, 'payload-cleanup-worker', lock_version, true
  );
  if completed->>'status' <> 'published' then raise exception 'payload outbox publish failed: %', completed; end if;
  if (select state from public.job_payload_assets
      where job_id = '82700000-0000-4000-8000-000000000001') <> 'deleted' then
    raise exception 'payload tombstone was not committed';
  end if;
end;
$$;
reset role;

-- Expired financial holds converge without interrupting a Job that still owns
-- a fresh execution lease. Terminal holds settle directly; unleased work gets
-- one canonical failed event/projection/outbox transition.
set role service_role;
do $$
declare result jsonb;
begin
  perform public.enqueue_job(
    '96100000-0000-4000-8000-000000000001',
    'chat.title', 'reservation_expired',
    '00000000-0000-4000-8000-000000000002', 'registered',
    '{"conversationId":"89900000-0000-4000-8000-000000000001"}'::jsonb,
    'reservation-expired-job', repeat('1', 64),
    '{"billingClass":"platform"}'::jsonb,
    '{"wallTimeMs":60000,"tokenLimit":8192}'::jsonb
  );
  perform public.enqueue_job(
    '96100000-0000-4000-8000-000000000002',
    'cleanup.reservation_terminal', 'reservation_terminal',
    '00000000-0000-4000-8000-000000000001', 'registered', '{}'::jsonb,
    'reservation-terminal-job', repeat('2', 64),
    '{"billingClass":"customer"}'::jsonb,
    '{"wallTimeMs":60000}'::jsonb
  );
  perform public.enqueue_job(
    '96100000-0000-4000-8000-000000000003',
    'cleanup.reservation_fresh', 'reservation_fresh',
    '00000000-0000-4000-8000-000000000001', 'registered', '{}'::jsonb,
    'reservation-fresh-job', repeat('3', 64),
    '{"billingClass":"customer"}'::jsonb,
    '{"wallTimeMs":60000}'::jsonb
  );
  result := public.cancel_job(
    '96100000-0000-4000-8000-000000000002',
    '00000000-0000-4000-8000-000000000001', 'terminal reservation fixture'
  );
  if result->>'status' <> 'cancelled' then raise exception 'terminal reservation setup failed'; end if;
  result := public.claim_next_job('fresh-reservation-worker', array['reservation_fresh'], 120);
  if result->>'acquired' <> 'true' then raise exception 'fresh reservation lease setup failed: %', result; end if;
end;
$$;
reset role;

do $$
begin
  if (select balance from public.profiles
      where user_id = '00000000-0000-4000-8000-000000000002') <> 5424
     or not exists (
       select 1 from public.job_admission_reservations
       where job_id = '96100000-0000-4000-8000-000000000001'
         and funding = 'balance' and reserved_tokens = 24576 and status = 'held'
     ) then
    raise exception 'paid expired reservation fixture did not hold its maximum';
  end if;
end;
$$;

update public.job_admission_reservations
set expires_at = clock_timestamp() - interval '1 second'
where job_id in (
  '96100000-0000-4000-8000-000000000001',
  '96100000-0000-4000-8000-000000000003'
);
update public.job_admission_reservations
set status = 'held', settled_at = null, release_reason = null,
    released_tokens = 0, expires_at = clock_timestamp() - interval '1 second'
where job_id = '96100000-0000-4000-8000-000000000002';

set role service_role;
do $$
declare result jsonb;
begin
  result := public.sweep_job_lifecycle(100, clock_timestamp() - interval '7 days');
  if (result->>'expiredReservationsReclaimed')::integer < 2 then
    raise exception 'expired reservation sweep did not reclaim eligible holds: %', result;
  end if;
end;
$$;
reset role;

do $$
begin
  if (select status from public.jobs
      where id = '96100000-0000-4000-8000-000000000001') <> 'failed'
     or (select error_code from public.jobs
         where id = '96100000-0000-4000-8000-000000000001') <> 'JOB_ADMISSION_EXPIRED'
     or not exists (
       select 1 from public.job_admission_reservations
       where job_id = '96100000-0000-4000-8000-000000000001'
         and status = 'released' and funding = 'balance'
         and released_tokens = reserved_tokens and reserved_tokens = 24576
         and settled_at is not null
     )
     or (select balance from public.profiles
         where user_id = '00000000-0000-4000-8000-000000000002') <> 30000
     or not exists (
       select 1 from public.job_events
       where job_id = '96100000-0000-4000-8000-000000000001'
         and kind = 'job.terminal' and payload->>'errorCode' = 'JOB_ADMISSION_EXPIRED'
     ) then
    raise exception 'expired unleased Job did not converge canonically';
  end if;
  if (select status from public.jobs
      where id = '96100000-0000-4000-8000-000000000002') <> 'cancelled'
     or not exists (
       select 1 from public.job_admission_reservations
       where job_id = '96100000-0000-4000-8000-000000000002'
         and status = 'released' and settled_at is not null
     ) then
    raise exception 'terminal expired reservation was not settled';
  end if;
  if (select status from public.jobs
      where id = '96100000-0000-4000-8000-000000000003') <> 'leased'
     or (select status from public.job_admission_reservations
         where job_id = '96100000-0000-4000-8000-000000000003') <> 'held' then
    raise exception 'fresh Job lease was interrupted by reservation sweep';
  end if;
end;
$$;

-- Expired leases and old delivered transport rows are removed in bounded
-- batches; dead letters and immutable audit/ledger records are not selected.
update public.job_stream_leases
set acquired_at = clock_timestamp() - interval '10 minutes',
    expires_at = clock_timestamp() - interval '9 minutes',
    hard_expires_at = clock_timestamp() - interval '1 minute'
where id = '96000000-0000-4000-8000-000000000002';
update public.job_outbox
set published_at = clock_timestamp() - interval '8 days',
    updated_at = clock_timestamp() - interval '8 days'
where job_id = '82700000-0000-4000-8000-000000000001'
  and topic = 'payloads.cleanup' and status = 'published';

set role service_role;
do $$
declare result jsonb;
begin
  result := public.sweep_job_lifecycle(100, clock_timestamp() - interval '7 days');
  if (result->>'streamLeasesDeleted')::integer < 1
     or (result->>'outboxDeleted')::integer < 1 then
    raise exception 'bounded lifecycle sweep did not collect fixtures: %', result;
  end if;
end;
$$;
reset role;
