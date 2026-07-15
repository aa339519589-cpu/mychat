\set ON_ERROR_STOP on

\if :{?BILLING_SETUP}
begin;

insert into auth.users(id) values
  ('b1290000-0000-4000-8000-000000000001')
on conflict (id) do nothing;
insert into public.profiles(user_id, balance, limit_5h, limit_week)
values ('b1290000-0000-4000-8000-000000000001', 30000, 0, 0)
on conflict (user_id) do update set
  balance = excluded.balance,
  limit_5h = excluded.limit_5h,
  limit_week = excluded.limit_week;
insert into public.conversations(id, user_id)
values (
  'b1292000-0000-4000-8000-000000000001',
  'b1290000-0000-4000-8000-000000000001'
)
on conflict (id) do nothing;

insert into public.job_price_catalog(
  sku, version, default_reserve_tokens, raw_token_cap,
  token_multiplier_millis, reserve_cost_micros, currency, active
) values
  ('billing.fixture', 1, 100, 100, 1000, 100, 'USD', false),
  ('billing.fixture', 2, 200, 200, 1000, 200, 'USD', false),
  ('billing.fixture', 3, 300, 300, 1000, 300, 'USD', false);
insert into public.job_price_activations(sku, price_version, activated_by)
values ('billing.fixture', 1, 'pg16.setup');

do $$
begin
  begin
    update public.job_price_catalog
    set reserve_cost_micros = reserve_cost_micros + 1
    where sku = 'billing.fixture' and version = 1;
    raise exception 'append-only catalog accepted an update';
  exception when sqlstate '55000' then null;
  end;
  begin
    delete from public.job_price_activations
    where sku = 'billing.fixture' and price_version = 1;
    raise exception 'append-only activation history accepted a delete';
  exception when sqlstate '55000' then null;
  end;
end;
$$;

-- Simulate an owner bypassing the admission trigger. The independent v2 guard
-- must still reject both terminal transition and ledger charging.
alter table public.jobs disable trigger jobs_reserve_admission;
do $$
begin
  begin
    insert into public.jobs(
      id, type, queue, principal_id, auth_class, subject, idempotency_key,
      input_hash, payload, budget, status, result, error_class, error_code,
      terminal_at, billing_contract_version
    ) values (
      'b1291000-0000-4000-8000-000000000003', 'billing.guard',
      'billing_fixture', 'b1290000-0000-4000-8000-000000000001',
      'registered', '{}'::jsonb, 'billing-guard-terminal', repeat('3', 64),
      '{}'::jsonb, '{}'::jsonb, 'failed', '{}'::jsonb, 'internal',
      'fixture_terminal', clock_timestamp(), 2
    );
    raise exception 'v2 Job started terminal without a reservation';
  exception when check_violation then null;
  end;

  insert into public.jobs(
    id, type, queue, principal_id, auth_class, subject, idempotency_key,
    input_hash, payload, budget, billing_contract_version
  ) values (
    'b1291000-0000-4000-8000-000000000002', 'billing.guard',
    'billing_fixture', 'b1290000-0000-4000-8000-000000000001',
    'registered', '{}'::jsonb, 'billing-guard-missing-reservation', repeat('2', 64),
    '{}'::jsonb, '{}'::jsonb, 2
  );
  begin
    update public.jobs set
      status = 'failed', result = '{}'::jsonb, error_class = 'internal',
      error_code = 'fixture_terminal', terminal_at = clock_timestamp()
    where id = 'b1291000-0000-4000-8000-000000000002';
    raise exception 'v2 terminal transition bypassed its reservation';
  exception when check_violation then null;
  end;
  begin
    insert into public.ledger_entries(
      principal_id, job_id, idempotency_key, reason, direction,
      weighted_tokens, raw_tokens, cost_estimate, currency, metadata
    ) values (
      'b1290000-0000-4000-8000-000000000001',
      'b1291000-0000-4000-8000-000000000002',
      'b1291000-0000-4000-8000-000000000002:attempt:1:forbidden',
      'missing_reservation', 'debit', 1, 1, 0, 'USD', '{"attempt":1}'::jsonb
    );
    raise exception 'v2 ledger entry bypassed its reservation';
  exception when check_violation then null;
  end;
  delete from public.jobs where id = 'b1291000-0000-4000-8000-000000000002';
end;
$$;
set constraints all immediate;
alter table public.jobs enable trigger jobs_reserve_admission;
set constraints all deferred;

set role service_role;
do $$
declare
  admission jsonb;
  claim jsonb;
  accounting jsonb;
begin
  admission := public.enqueue_job(
    'b1291000-0000-4000-8000-000000000001',
    'chat.title', 'billing_fixture',
    'b1290000-0000-4000-8000-000000000001', 'registered',
    '{"conversationId":"b1292000-0000-4000-8000-000000000001"}'::jsonb,
    'billing-reconciliation-fixture', repeat('1', 64),
    '{"billingClass":"platform"}'::jsonb,
    '{"tokenLimit":8192,"wallTimeMs":60000}'::jsonb
  );
  if admission->>'enqueued' <> 'true' then
    raise exception 'billing fixture was not admitted: %', admission;
  end if;
  claim := public.claim_next_job(
    'pg16-billing-worker', array['billing_fixture'], 120
  );
  if claim->>'acquired' <> 'true'
     or claim->'job'->>'id' <> 'b1291000-0000-4000-8000-000000000001' then
    raise exception 'billing fixture was not claimed: %', claim;
  end if;
  accounting := public.record_job_accounting(
    'b1291000-0000-4000-8000-000000000001', 'pg16-billing-worker', 1, 1,
    jsonb_build_array(
      jsonb_build_object(
        'idempotencyKey',
          'b1291000-0000-4000-8000-000000000001:attempt:1:gross',
        'reason', 'billing_fixture_gross', 'direction', 'debit',
        'weightedTokens', 100, 'rawTokens', 100, 'costEstimate', 0.00010000,
        'currency', 'USD', 'metadata', jsonb_build_object('attempt', 1)
      ),
      jsonb_build_object(
        'idempotencyKey',
          'b1291000-0000-4000-8000-000000000001:attempt:1:reversal',
        'reason', 'billing_fixture_reversal', 'direction', 'credit',
        'weightedTokens', 20, 'rawTokens', 20, 'costEstimate', 0.00002000,
        'currency', 'USD', 'metadata', jsonb_build_object('attempt', 1)
      )
    )
  );
  if accounting->>'recorded' <> 'true' or accounting->>'replayed' <> 'false' then
    raise exception 'billing accounting was not recorded: %', accounting;
  end if;
  accounting := public.record_job_accounting(
    'b1291000-0000-4000-8000-000000000001', 'pg16-billing-worker', 1, 1,
    jsonb_build_array(
      jsonb_build_object(
        'idempotencyKey',
          'b1291000-0000-4000-8000-000000000001:attempt:1:gross',
        'reason', 'billing_fixture_gross', 'direction', 'debit',
        'weightedTokens', 100, 'rawTokens', 100, 'costEstimate', 0.00010000,
        'currency', 'USD', 'metadata', jsonb_build_object('attempt', 1)
      ),
      jsonb_build_object(
        'idempotencyKey',
          'b1291000-0000-4000-8000-000000000001:attempt:1:reversal',
        'reason', 'billing_fixture_reversal', 'direction', 'credit',
        'weightedTokens', 20, 'rawTokens', 20, 'costEstimate', 0.00002000,
        'currency', 'USD', 'metadata', jsonb_build_object('attempt', 1)
      )
    )
  );
  if accounting->>'recorded' <> 'true' or accounting->>'replayed' <> 'true' then
    raise exception 'billing accounting replay was not idempotent: %', accounting;
  end if;
end;
$$;
reset role;

do $$
declare
  reservation public.job_admission_reservations%rowtype;
  settlement jsonb;
  function_source text;
  job_lock_position integer;
  reservation_lock_position integer;
begin
  select prosrc into strict function_source
  from pg_proc
  where oid = 'public.settle_job_admission(uuid,text)'::regprocedure;
  job_lock_position := strpos(
    function_source,
    'select * into v_job from public.jobs'
  );
  reservation_lock_position := strpos(
    function_source,
    'select * into v_reservation from public.job_admission_reservations'
  );
  if job_lock_position = 0
     or reservation_lock_position = 0
     or job_lock_position >= reservation_lock_position then
    raise exception 'settlement does not lock Job before reservation: %/%',
      job_lock_position, reservation_lock_position;
  end if;

  settlement := public.settle_job_admission(
    'b1291000-0000-4000-8000-000000000099', 'pg16.not_reserved'
  );
  if settlement->>'settled' <> 'false'
     or settlement->>'replayed' <> 'false'
     or settlement->>'reason' <> 'not_reserved' then
    raise exception 'missing reservation semantics changed: %', settlement;
  end if;

  select * into strict reservation
  from public.job_admission_reservations
  where job_id = 'b1291000-0000-4000-8000-000000000001';
  if reservation.funding <> 'balance'
     or reservation.reserved_tokens <> 24576
     or reservation.price_quote->>'schemaVersion' <> '2'
     or reservation.price_quote->>'authorizedTokens' <> '24576'
     or reservation.price_quote_hash <>
       public.job_price_quote_hash(reservation.price_quote)
     or (select payload->'admission'->>'quoteHash' from public.jobs
         where id = reservation.job_id) <> reservation.price_quote_hash then
    raise exception 'canonical admission quote was not durably bound: %', reservation;
  end if;
  begin
    update public.job_admission_reservations
    set price_quote = price_quote || '{"authorizedTokens":1}'::jsonb
    where job_id = reservation.job_id;
    raise exception 'immutable quote accepted a rewrite';
  exception when sqlstate '55000' then null;
  end;

  settlement := public.settle_job_admission(
    reservation.job_id, 'pg16.not_terminal'
  );
  if settlement->>'settled' <> 'false'
     or settlement->>'replayed' <> 'false'
     or settlement->>'reason' <> 'job_not_terminal'
     or (select status from public.job_admission_reservations
         where job_id = reservation.job_id) <> 'held' then
    raise exception 'non-terminal settlement semantics changed: %', settlement;
  end if;
end;
$$;

do $$
begin
  if has_function_privilege(
       'authenticated', 'public.read_billing_reconciliation_v1()', 'EXECUTE'
     )
     or has_function_privilege(
       'authenticated', 'public.refresh_billing_reconciliation_v1()', 'EXECUTE'
     )
     or has_function_privilege(
       'anon', 'public.read_billing_reconciliation_v1()', 'EXECUTE'
     )
     or has_table_privilege(
       'authenticated', 'public.billing_reconciliation_snapshots', 'SELECT'
     )
     or not has_function_privilege(
       'service_role', 'public.read_billing_reconciliation_v1()', 'EXECUTE'
     )
     or not has_function_privilege(
       'service_role', 'public.refresh_billing_reconciliation_v1()', 'EXECUTE'
     ) then
    raise exception 'billing reconciliation privilege boundary is open';
  end if;
  if exists (
    select 1 from pg_class
    where oid in (
      'public.job_price_activations'::regclass,
      'public.job_price_activation_heads'::regclass,
      'public.job_balance_movements'::regclass,
      'public.profile_balance_anchors'::regclass,
      'public.profile_balance_journal'::regclass,
      'public.billing_reconciliation_snapshots'::regclass
    ) and not relrowsecurity
  ) then
    raise exception 'billing authority table is missing RLS';
  end if;
end;
$$;

create or replace function public.pg16_billing_finalize_attempt()
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare result jsonb;
begin
  result := public.finalize_job(
    'b1291000-0000-4000-8000-000000000001',
    'pg16-billing-worker', 1, 'failed', '{}'::jsonb,
    'internal', 'billing_fixture_terminal'
  );
  return (result->>'finalized') || ':' || (result->>'replayed') || ':'
    || coalesce(result->>'status', 'null');
end;
$$;
revoke all on function public.pg16_billing_finalize_attempt()
  from public, anon, authenticated, service_role;
grant execute on function public.pg16_billing_finalize_attempt() to service_role;

-- The harness starts this function first, waits until the pause is observable,
-- then calls settle_job_admission from another session. A reservation-first
-- implementation deadlocks when this transaction reaches its deferred trigger;
-- the canonical Job-first order lets finalization commit and settlement replay.
create or replace function public.pg16_billing_finalize_after_job_lock()
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform 1
  from public.jobs
  where id = 'b1291000-0000-4000-8000-000000000001'
  for update;
  if not found then
    raise exception 'billing lock-order fixture Job is missing';
  end if;
  perform pg_sleep(2);
  return public.pg16_billing_finalize_attempt();
end;
$$;
revoke all on function public.pg16_billing_finalize_after_job_lock()
  from public, anon, authenticated, service_role;
grant execute on function public.pg16_billing_finalize_after_job_lock()
  to service_role;

create or replace function public.pg16_activate_billing_price(input_version integer)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare inserted integer;
begin
  insert into public.job_price_activations(sku, price_version, activated_by)
  values ('billing.fixture', input_version, 'pg16.concurrent');
  get diagnostics inserted = row_count;
  return case when inserted = 1 then 'activated' else 'replayed' end;
exception when check_violation then
  return 'rejected';
end;
$$;
revoke all on function public.pg16_activate_billing_price(integer)
  from public, anon, authenticated, service_role;
grant execute on function public.pg16_activate_billing_price(integer) to service_role;

create or replace function public.pg16_refresh_billing_snapshot()
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.refresh_billing_reconciliation_v1();
  return 'refreshed';
exception when lock_not_available then
  return 'busy';
end;
$$;
revoke all on function public.pg16_refresh_billing_snapshot()
  from public, anon, authenticated, service_role;
grant execute on function public.pg16_refresh_billing_snapshot() to service_role;

commit;
\endif

\if :{?BILLING_VERIFY}
begin;

do $$
declare
  replay jsonb;
  current_balance bigint;
  held bigint;
  debited bigint;
  credited bigint;
  released bigint;
begin
  select balance::bigint into current_balance
  from public.profiles
  where user_id = 'b1290000-0000-4000-8000-000000000001';
  select
    coalesce(sum(tokens) filter (where kind = 'hold'), 0)::bigint,
    coalesce(sum(tokens) filter (where kind = 'debit'), 0)::bigint,
    coalesce(sum(tokens) filter (where kind = 'credit'), 0)::bigint,
    coalesce(sum(tokens) filter (where kind = 'release'), 0)::bigint
  into held, debited, credited, released
  from public.job_balance_movements
  where job_id = 'b1291000-0000-4000-8000-000000000001';
  if current_balance <> 29920
     or (held, debited, credited, released) <> (24576, 100, 20, 24496)
     or held <> debited - credited + released
     or not exists (
       select 1
       from public.job_admission_reservations
       where job_id = 'b1291000-0000-4000-8000-000000000001'
         and status = 'settled' and actual_tokens = 80
         and actual_cost_micros = 80 and released_tokens = 24496
     )
     or not exists (
       select 1
       from public.ledger_balance_settlements as settlement
       join public.ledger_entries as entry
         on entry.id = settlement.ledger_entry_id
        and entry.principal_id = settlement.principal_id
       where entry.job_id = 'b1291000-0000-4000-8000-000000000001'
         and entry.direction = 'debit'
         and settlement.requested_tokens = 100
         and settlement.debited_tokens = 100
         and settlement.remaining_balance = 29920
     ) then
    raise exception 'terminal balance receipt equation failed: %/%/%/%/%',
      current_balance, held, debited, credited, released;
  end if;
  replay := public.settle_job_admission(
    'b1291000-0000-4000-8000-000000000001', 'pg16.replay'
  );
  if replay->>'settled' <> 'true' or replay->>'replayed' <> 'true' then
    raise exception 'terminal settlement replay was not idempotent: %', replay;
  end if;
end;
$$;

do $$
declare
  replay_result text;
  head_generation bigint;
  history_count bigint;
  latest_generation bigint;
begin
  if (select price_version from public.job_price_activation_heads
      where sku = 'billing.fixture') <> 3 then
    raise exception 'concurrent activation did not converge on version 3';
  end if;
  replay_result := public.pg16_activate_billing_price(2);
  if replay_result not in ('replayed', 'rejected')
     or (select price_version from public.job_price_activation_heads
         where sku = 'billing.fixture') <> 3 then
    raise exception 'price activation moved backward after the race: %', replay_result;
  end if;
  select activation_generation into strict head_generation
  from public.job_price_activation_heads
  where sku = 'billing.fixture';
  select count(*), max(activation_generation)
    into history_count, latest_generation
  from public.job_price_activations
  where sku = 'billing.fixture';
  -- If v3 wins the row CAS first, v2 is correctly rejected and the log has
  -- two generations. If v2 wins first, both forward moves commit. Either
  -- history must be contiguous and end at the exact mutable head.
  if head_generation not between 2 and 3
     or history_count <> head_generation
     or latest_generation <> head_generation then
    raise exception 'activation head and immutable history diverged: %/%/%',
      head_generation, history_count, latest_generation;
  end if;
end;
$$;

-- Earlier negative fixtures intentionally left malformed pre-contract Agent
-- identities that predate terminal projection. Suppress only that projection
-- while the test drains them; state, accounting and lifecycle triggers remain
-- active, and production cutover requires this legacy-active count to be zero.
alter table public.jobs disable trigger jobs_project_terminal;
update public.jobs set
  status = 'failed',
  result = coalesce(result, '{}'::jsonb),
  error_class = 'internal',
  error_code = 'pg16_billing_cutover_drain',
  event_sequence = event_sequence + 1,
  lease_owner = null,
  lease_expires_at = null,
  terminal_at = clock_timestamp(),
  updated_at = clock_timestamp()
where billing_contract_version = 1
  and status not in ('completed', 'failed', 'cancelled');
set constraints all immediate;
alter table public.jobs enable trigger jobs_project_terminal;
set constraints all deferred;

select public.refresh_billing_reconciliation_v1();

set role service_role;
do $$
declare snapshot jsonb;
begin
  snapshot := public.read_billing_reconciliation_v1();
  if snapshot->>'healthy' <> 'true'
     or snapshot->>'releaseReady' <> 'true'
     or snapshot->>'totalMismatches' <> '0'
     or snapshot->>'releaseBlockers' <> '0'
     or snapshot->>'activeLegacyJobs' <> '0'
     or not public.runtime_healthcheck_v13() then
    raise exception 'authoritative billing release gate did not close cleanly: %', snapshot;
  end if;
end;
$$;
reset role;

savepoint unhealthy_fresh_snapshot;
update public.billing_reconciliation_snapshots set
  healthy = false,
  generated_at = clock_timestamp(),
  metrics = metrics || jsonb_build_object(
    'generatedAt', clock_timestamp(),
    'healthy', false,
    'releaseReady', false,
    'releaseBlockers', 1,
    'totalMismatches', 1
  );
set role service_role;
do $$
begin
  if public.runtime_healthcheck_v13() then
    raise exception 'v13 accepted a fresh unhealthy reconciliation snapshot';
  end if;
end;
$$;
reset role;
rollback to savepoint unhealthy_fresh_snapshot;

savepoint missing_admission_trigger;
drop trigger jobs_reserve_admission on public.jobs;
set role service_role;
do $$
begin
  if public.runtime_healthcheck_v13() then
    raise exception 'v13 accepted a missing atomic admission trigger';
  end if;
end;
$$;
reset role;
rollback to savepoint missing_admission_trigger;

savepoint open_refresh_privilege;
grant execute on function public.refresh_billing_reconciliation_v1() to authenticated;
set role service_role;
do $$
begin
  if public.runtime_healthcheck_v13() then
    raise exception 'v13 accepted an open reconciliation refresh privilege';
  end if;
end;
$$;
reset role;
rollback to savepoint open_refresh_privilege;

commit;
\endif
