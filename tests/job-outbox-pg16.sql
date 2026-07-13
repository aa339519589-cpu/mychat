\set ON_ERROR_STOP on

set role service_role;
do $$
declare
  claimed jsonb;
begin
  claimed := public.claim_job_outbox('asset-dispatcher', array['assets.cleanup'], 15);
  if claimed->>'acquired' <> 'true'
     or claimed->'message'->>'lockVersion' <> '1'
     or claimed->'message'->>'attempt' <> '1' then
    raise exception 'initial outbox claim failed: %', claimed;
  end if;
end;
$$;
reset role;

-- Simulate worker death, then the same worker id reclaiming the row. The
-- monotonically increasing generation must reject its old acknowledgement.
update public.job_outbox
set lock_expires_at = clock_timestamp() - interval '1 second'
where job_id = '84000000-0000-4000-8000-000000000002'
  and topic = 'assets.cleanup';

set role service_role;
do $$
declare
  reclaimed jsonb;
  result jsonb;
  outbox_id uuid;
  orphan_key text := '00000000-0000-4000-8000-000000000001/80000000-0000-4000-8000-000000000002/84000000-0000-4000-8000-000000000002/orphan.png';
begin
  reclaimed := public.claim_job_outbox('asset-dispatcher', array['assets.cleanup'], 15);
  if reclaimed->>'acquired' <> 'true'
     or reclaimed->'message'->>'lockVersion' <> '2'
     or reclaimed->'message'->>'attempt' <> '2' then
    raise exception 'expired outbox reclaim failed: %', reclaimed;
  end if;
  outbox_id := (reclaimed->'message'->>'id')::uuid;
  result := public.complete_job_outbox(outbox_id, 'asset-dispatcher', 1, true);
  if result->>'reason' <> 'stale_lock' then
    raise exception 'old outbox generation acknowledged a new lease: %', result;
  end if;

  result := public.prepare_job_asset_cleanup(outbox_id, 'asset-dispatcher', 2);
  if result->>'prepared' <> 'true'
     or result->'objectKeys' <> jsonb_build_array(orphan_key) then
    raise exception 'asset cleanup preparation failed: %', result;
  end if;
  result := public.finish_job_asset_cleanup(
    outbox_id, 'asset-dispatcher', 2, array[orphan_key]
  );
  if result->>'finished' <> 'true' then
    raise exception 'asset cleanup completion failed: %', result;
  end if;
  result := public.complete_job_outbox(outbox_id, 'asset-dispatcher', 2, true);
  if result->>'completed' <> 'true' or result->>'status' <> 'published' then
    raise exception 'outbox publish failed: %', result;
  end if;

  if (select state from public.job_assets
      where job_id = '84000000-0000-4000-8000-000000000002') <> 'deleted' then
    raise exception 'orphan asset did not converge to deleted';
  end if;
  if (select state from public.job_assets
      where job_id = '84000000-0000-4000-8000-000000000001') <> 'canonical' then
    raise exception 'canonical asset was selected for cleanup';
  end if;

  begin
    update public.job_outbox set status = 'dead' where id = outbox_id;
    raise exception 'service role bypassed outbox RPCs';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.job_assets set state = 'deleting'
    where job_id = '84000000-0000-4000-8000-000000000001';
    raise exception 'service role bypassed asset cleanup RPCs';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset role;

-- The final failed delivery must enter the dead-letter state.
insert into public.job_outbox(
  job_id, principal_id, topic, dedupe_key, payload,
  status, attempts, max_attempts, available_at
) values (
  '84000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000001',
  'jobs.poison', 'pg16-outbox-poison', '{}'::jsonb,
  'failed', 9, 10, clock_timestamp()
);

set role service_role;
do $$
declare
  claimed jsonb;
  result jsonb;
begin
  claimed := public.claim_job_outbox('poison-dispatcher', array['jobs.poison'], 15);
  if claimed->>'acquired' <> 'true' or claimed->'message'->>'attempt' <> '10' then
    raise exception 'final outbox attempt was not claimed: %', claimed;
  end if;
  result := public.complete_job_outbox(
    (claimed->'message'->>'id')::uuid,
    'poison-dispatcher',
    (claimed->'message'->>'lockVersion')::bigint,
    false, 'provider_unavailable', 1
  );
  if result->>'status' <> 'dead' then
    raise exception 'final outbox failure was not dead-lettered: %', result;
  end if;
end;
$$;
reset role;

set role authenticated;
do $$
begin
  begin
    perform public.claim_job_outbox('browser', array['jobs.ready'], 15);
    raise exception 'authenticated role claimed service outbox';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset role;
