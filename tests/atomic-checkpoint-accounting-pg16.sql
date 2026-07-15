\set ON_ERROR_STOP on

insert into auth.users(id) values
  ('b1300000-0000-4000-8000-000000000001')
on conflict (id) do nothing;
insert into public.profiles(user_id, balance, limit_5h, limit_week)
values ('b1300000-0000-4000-8000-000000000001', 0, 1000000, 1000000)
on conflict (user_id) do update set
  limit_5h = excluded.limit_5h,
  limit_week = excluded.limit_week;
insert into public.profile_balance_anchors(principal_id, balance)
values ('b1300000-0000-4000-8000-000000000001', 0)
on conflict (principal_id) do nothing;
insert into public.conversations(id, user_id)
values (
  'b1302000-0000-4000-8000-000000000001',
  'b1300000-0000-4000-8000-000000000001'
)
on conflict (id) do nothing;

set role service_role;

-- Attempt one durably binds ten tokens to checkpoint version one. The same RPC
-- is a replay, while either a changed payload or stale version fails closed.
do $$
declare
  result jsonb;
  ledger jsonb := '[{
    "idempotencyKey":"b1301000-0000-4000-8000-000000000001:attempt:1:model-10",
    "reason":"platform_model_usage","direction":"debit",
    "weightedTokens":10,"rawTokens":10,"costEstimate":0.000010,
    "currency":"USD","metadata":{
      "attempt":1,"accountingKey":"model-usage","costMicros":10,
      "cumulativeRawTokens":10,"cumulativeWeightedTokens":10,
      "cumulativeCostMicros":10
    }
  }]'::jsonb;
begin
  result := public.enqueue_job(
    'b1301000-0000-4000-8000-000000000001', 'chat.title', 'atomic_checkpoint',
    'b1300000-0000-4000-8000-000000000001', 'registered',
    '{"conversationId":"b1302000-0000-4000-8000-000000000001"}'::jsonb,
    'atomic-two-attempts', repeat('1', 64),
    '{"schemaVersion":1,"billingClass":"platform"}'::jsonb,
    '{"wallTimeMs":60000,"tokenLimit":100}'::jsonb, 0, 2
  );
  result := public.claim_next_job('atomic-worker-1', array['atomic_checkpoint'], 120);
  if result->>'acquired' <> 'true' or result->'job'->>'attempt' <> '1' then
    raise exception 'atomic attempt one claim failed: %', result;
  end if;
  result := public.checkpoint_job_with_accounting(
    'b1301000-0000-4000-8000-000000000001', 'atomic-worker-1', 1, 1, 0,
    'b1301000-attempt-1-checkpoint-1', 'chat.model_round',
    '{"schemaVersion":1,"round":1}'::jsonb, '{"totalTokens":10}'::jsonb,
    true, 'running', ledger
  );
  if result->>'checkpointed' <> 'true'
     or result->>'replayed' <> 'false'
     or result->>'checkpointVersion' <> '1' then
    raise exception 'atomic checkpoint did not commit: %', result;
  end if;
  result := public.checkpoint_job_with_accounting(
    'b1301000-0000-4000-8000-000000000001', 'atomic-worker-1', 1, 1, 0,
    'b1301000-attempt-1-checkpoint-1', 'chat.model_round',
    '{"schemaVersion":1,"round":1}'::jsonb, '{"totalTokens":10}'::jsonb,
    true, 'running', ledger
  );
  if result->>'checkpointed' <> 'true' or result->>'replayed' <> 'true' then
    raise exception 'atomic checkpoint replay was not idempotent: %', result;
  end if;
  begin
    perform public.checkpoint_job_with_accounting(
      'b1301000-0000-4000-8000-000000000001', 'atomic-worker-1', 1, 1, 0,
      'b1301000-attempt-1-checkpoint-1', 'chat.model_round',
      '{"schemaVersion":1,"round":1}'::jsonb, '{"totalTokens":11}'::jsonb,
      true, 'running', ledger
    );
    raise exception 'conflicting checkpoint replay was accepted';
  exception when unique_violation then null;
  end;
  result := public.checkpoint_job_with_accounting(
    'b1301000-0000-4000-8000-000000000001', 'atomic-worker-1', 1, 1, 0,
    'b1301000-attempt-1-checkpoint-other', 'chat.model_round',
    '{"schemaVersion":1,"round":2}'::jsonb, '{"totalTokens":10}'::jsonb,
    true, 'running', '[]'::jsonb
  );
  if result->>'reason' <> 'checkpoint_version_conflict' then
    raise exception 'stale checkpoint CAS was accepted: %', result;
  end if;
  result := public.retry_job(
    'b1301000-0000-4000-8000-000000000001', 'atomic-worker-1', 1,
    'provider', 'fixture_retry', 1
  );
  if result->>'retried' <> 'true' then raise exception 'fixture retry failed: %', result; end if;
  result := public.checkpoint_job_with_accounting(
    'b1301000-0000-4000-8000-000000000001', 'atomic-worker-1', 1, 1, 0,
    'b1301000-attempt-1-checkpoint-1', 'chat.model_round',
    '{"schemaVersion":1,"round":1}'::jsonb, '{"totalTokens":10}'::jsonb,
    true, 'running', ledger
  );
  if result->>'checkpointed' <> 'false' or result->>'reason' <> 'stale_fence' then
    raise exception 'replay receipt incorrectly revived a released fence: %', result;
  end if;
end;
$$;

select pg_sleep(1.1);

-- Attempt two reports its own cumulative 15 tokens. The ledger stores a new
-- immutable delta, so terminal settlement is exactly 10 + 15, never 10 + 25.
do $$
declare result jsonb;
begin
  result := public.claim_next_job('atomic-worker-2', array['atomic_checkpoint'], 120);
  if result->>'acquired' <> 'true' or result->'job'->>'attempt' <> '2'
     or result->'job'->'usage'->>'rawTokens' <> '10' then
    raise exception 'atomic attempt two claim/usage failed: %', result;
  end if;
  result := public.checkpoint_job_with_accounting(
    'b1301000-0000-4000-8000-000000000001', 'atomic-worker-2', 2, 2, 1,
    'b1301000-attempt-2-checkpoint-2', 'chat.model_round',
    '{"schemaVersion":1,"round":2}'::jsonb, '{"totalTokens":25}'::jsonb,
    true, 'running', '[{
      "idempotencyKey":"b1301000-0000-4000-8000-000000000001:attempt:2:model-15",
      "reason":"platform_model_usage","direction":"debit",
      "weightedTokens":15,"rawTokens":15,"costEstimate":0.000015,
      "currency":"USD","metadata":{
        "attempt":2,"accountingKey":"model-usage","costMicros":15,
        "cumulativeRawTokens":15,"cumulativeWeightedTokens":15,
        "cumulativeCostMicros":15
      }
    }]'::jsonb
  );
  if result->>'checkpointed' <> 'true' then
    raise exception 'attempt two checkpoint failed: %', result;
  end if;
  result := public.finalize_job(
    'b1301000-0000-4000-8000-000000000001', 'atomic-worker-2', 2,
    'completed', '{"ok":true}'::jsonb
  );
  if result->>'finalized' <> 'true' or result->>'status' <> 'completed' then
    raise exception 'two-attempt finalization failed: %', result;
  end if;
end;
$$;

-- A maxAttempts=1 worker crashes after the atomic checkpoint. Expiry recovery
-- terminalizes the job and the deferred billing trigger settles the seven
-- durable tokens instead of releasing the entire reservation.
do $$
declare result jsonb;
begin
  result := public.enqueue_job(
    'b1301000-0000-4000-8000-000000000002', 'chat.title', 'atomic_crash',
    'b1300000-0000-4000-8000-000000000001', 'registered',
    '{"conversationId":"b1302000-0000-4000-8000-000000000001"}'::jsonb,
    'atomic-max-attempt-crash', repeat('2', 64),
    '{"schemaVersion":1,"billingClass":"platform"}'::jsonb,
    '{"wallTimeMs":60000,"tokenLimit":100}'::jsonb, 0, 1
  );
  result := public.claim_next_job('atomic-crash-worker', array['atomic_crash'], 120);
  if result->>'acquired' <> 'true' then raise exception 'crash fixture claim failed: %', result; end if;
  result := public.checkpoint_job_with_accounting(
    'b1301000-0000-4000-8000-000000000002', 'atomic-crash-worker', 1, 1, 0,
    'b1301000-crash-checkpoint-1', 'chat.model_round',
    '{"schemaVersion":1,"round":1}'::jsonb, '{"totalTokens":7}'::jsonb,
    true, 'running', '[{
      "idempotencyKey":"b1301000-0000-4000-8000-000000000002:attempt:1:model-7",
      "reason":"platform_model_usage","direction":"debit",
      "weightedTokens":7,"rawTokens":7,"costEstimate":0.000007,
      "currency":"USD","metadata":{"attempt":1,"accountingKey":"model-usage","costMicros":7}
    }]'::jsonb
  );
  if result->>'checkpointed' <> 'true' then raise exception 'crash checkpoint failed: %', result; end if;
end;
$$;
reset role;

update public.jobs set lease_expires_at = clock_timestamp() - interval '1 second'
where id = 'b1301000-0000-4000-8000-000000000002';

set role service_role;
do $$
declare result jsonb;
begin
  result := public.claim_next_job('atomic-recovery-worker', array['atomic_crash'], 120);
  if result->>'acquired' <> 'false'
     or result->>'reason' <> 'job_attempts_exhausted'
     or result->'job'->>'status' <> 'failed' then
    raise exception 'max-attempt crash did not settle terminally: %', result;
  end if;
end;
$$;
reset role;

-- Force the checkpoint half to fail after ledger insertion. PL/pgSQL exception
-- handling creates a subtransaction; neither side may survive the failure.
set role service_role;
do $$
declare result jsonb;
begin
  result := public.enqueue_job(
    'b1301000-0000-4000-8000-000000000003', 'chat.title', 'atomic_rollback',
    'b1300000-0000-4000-8000-000000000001', 'registered',
    '{"conversationId":"b1302000-0000-4000-8000-000000000001"}'::jsonb,
    'atomic-rollback', repeat('3', 64),
    '{"schemaVersion":1,"billingClass":"platform"}'::jsonb,
    '{"wallTimeMs":60000,"tokenLimit":100}'::jsonb, 0, 1
  );
  result := public.claim_next_job('atomic-rollback-worker', array['atomic_rollback'], 120);
  if result->>'acquired' <> 'true' then raise exception 'rollback fixture claim failed: %', result; end if;
end;
$$;
reset role;

create or replace function public.pg16_reject_atomic_checkpoint()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  raise exception 'forced_checkpoint_failure' using errcode = '40001';
end;
$$;
create trigger pg16_reject_atomic_checkpoint
before insert or update on public.job_checkpoints
for each row when (new.job_id = 'b1301000-0000-4000-8000-000000000003'::uuid)
execute function public.pg16_reject_atomic_checkpoint();

set role service_role;
do $$
begin
  begin
    perform public.checkpoint_job_with_accounting(
      'b1301000-0000-4000-8000-000000000003', 'atomic-rollback-worker', 1, 1, 0,
      'b1301000-rollback-checkpoint-1', 'chat.model_round',
      '{"schemaVersion":1}'::jsonb, '{"totalTokens":9}'::jsonb,
      true, 'running', '[{
        "idempotencyKey":"b1301000-0000-4000-8000-000000000003:attempt:1:model-9",
        "reason":"platform_model_usage","direction":"debit",
        "weightedTokens":9,"rawTokens":9,"costEstimate":0.000009,
        "currency":"USD","metadata":{"attempt":1,"accountingKey":"model-usage","costMicros":9}
      }]'::jsonb
    );
    raise exception 'forced checkpoint failure unexpectedly committed';
  exception when serialization_failure then null;
  end;
end;
$$;
reset role;

drop trigger pg16_reject_atomic_checkpoint on public.job_checkpoints;
drop function public.pg16_reject_atomic_checkpoint();

do $$
begin
  if exists (
       select 1 from public.ledger_entries
       where job_id = 'b1301000-0000-4000-8000-000000000003'
     ) or exists (
       select 1 from public.job_checkpoints
       where job_id = 'b1301000-0000-4000-8000-000000000003'
     ) then
    raise exception 'atomic checkpoint failure left partial durable state';
  end if;
end;
$$;

set role service_role;
select public.finalize_job(
  'b1301000-0000-4000-8000-000000000003', 'atomic-rollback-worker', 1,
  'failed', '{}'::jsonb, 'internal', 'fixture_cleanup'
);
reset role;

do $$
begin
  if (select coalesce(sum(raw_tokens), 0) from public.ledger_entries
      where job_id = 'b1301000-0000-4000-8000-000000000001') <> 25
     or (select count(*) from public.ledger_entries
         where job_id = 'b1301000-0000-4000-8000-000000000001') <> 2
     or not exists (
       select 1 from public.job_admission_reservations
       where job_id = 'b1301000-0000-4000-8000-000000000001'
         and status = 'settled' and actual_tokens = 25
     )
     or not exists (
       select 1 from public.job_admission_reservations
       where job_id = 'b1301000-0000-4000-8000-000000000002'
         and status = 'settled' and actual_tokens = 7
     ) then
    raise exception 'atomic checkpoint settlement totals are not exact';
  end if;
  if has_function_privilege(
       'authenticated',
       'public.checkpoint_job_with_accounting(uuid,text,bigint,integer,bigint,text,text,jsonb,jsonb,boolean,text,jsonb)',
       'EXECUTE'
     ) then
    raise exception 'browser checkpoint authority remained open';
  end if;
end;
$$;

set role service_role;
do $$
begin
  begin
    perform public.checkpoint_job(
      'b1301000-0000-4000-8000-000000000001', 'stale-client', 2,
      'chat.model_round', '{}'::jsonb, '{}'::jsonb, true, 'running'
    );
    raise exception 'legacy checkpoint RPC remained operational';
  exception when object_not_in_prerequisite_state then null;
  end;
end;
$$;
reset role;

set role service_role;
select public.refresh_billing_reconciliation_v1();
do $$
begin
  if not public.runtime_healthcheck_v14() then
    raise exception 'runtime healthcheck v14 rejected the atomic contract';
  end if;
end;
$$;
reset role;
