\set ON_ERROR_STOP on

set role service_role;

do $$
declare
  result jsonb;
begin
  begin
    perform public.enqueue_job(
      '89800000-0000-4000-8000-000000000009', 'cleanup.invalid_budget', 'budget_test',
      '00000000-0000-4000-8000-000000000001', 'registered', '{}'::jsonb,
      'invalid-budget-intent', repeat('9', 64), '{}'::jsonb,
      '{"tokenLimit":1.5}'::jsonb
    );
    raise exception 'fractional budget was accepted';
  exception when sqlstate '22023' then null;
  end;

  result := public.enqueue_job(
    '89800000-0000-4000-8000-000000000001', 'cleanup.budget_test', 'budget_test',
    '00000000-0000-4000-8000-000000000001', 'registered', '{}'::jsonb,
    'budget-accounting-intent', repeat('8', 64), '{}'::jsonb,
    '{"wallTimeMs":60000,"tokenLimit":100,"costMicros":1000,"sandboxTimeMs":50000,"toolCallLimit":10}'::jsonb,
    0, 3
  );
  result := public.claim_next_job('budget-worker-1', array['budget_test'], 120);
  if result->>'acquired' <> 'true' or result->'job'->>'attempt' <> '1' then
    raise exception 'budget fixture claim failed: %', result;
  end if;

  result := public.record_job_accounting(
    '89800000-0000-4000-8000-000000000001', 'budget-worker-1', 1, 1,
    '[
      {
        "idempotencyKey":"89800000-0000-4000-8000-000000000001:attempt:1:model",
        "reason":"platform_model_usage","direction":"debit",
        "weightedTokens":12,"rawTokens":10,"costEstimate":0.000005,
        "currency":"USD","metadata":{"attempt":1,"costMicros":5}
      },
      {
        "idempotencyKey":"89800000-0000-4000-8000-000000000001:attempt:1:resource",
        "reason":"job_resource_usage","direction":"debit",
        "weightedTokens":0,"rawTokens":0,"costEstimate":0,
        "currency":"USD","metadata":{"attempt":1,"wallTimeMs":25,"sandboxTimeMs":7,"toolCalls":2,"costMicros":0}
      }
    ]'::jsonb
  );
  if result->>'recorded' <> 'true' or result->>'replayed' <> 'false' then
    raise exception 'initial accounting failed: %', result;
  end if;

  result := public.record_job_accounting(
    '89800000-0000-4000-8000-000000000001', 'budget-worker-1', 1, 1,
    '[
      {
        "idempotencyKey":"89800000-0000-4000-8000-000000000001:attempt:1:model",
        "reason":"platform_model_usage","direction":"debit",
        "weightedTokens":12,"rawTokens":10,"costEstimate":0.000005,
        "currency":"USD","metadata":{"attempt":1,"costMicros":5}
      },
      {
        "idempotencyKey":"89800000-0000-4000-8000-000000000001:attempt:1:resource",
        "reason":"job_resource_usage","direction":"debit",
        "weightedTokens":0,"rawTokens":0,"costEstimate":0,
        "currency":"USD","metadata":{"attempt":1,"wallTimeMs":25,"sandboxTimeMs":7,"toolCalls":2,"costMicros":0}
      }
    ]'::jsonb
  );
  if result->>'recorded' <> 'true' or result->>'replayed' <> 'true' then
    raise exception 'accounting replay was not accepted: %', result;
  end if;

  begin
    perform public.record_job_accounting(
      '89800000-0000-4000-8000-000000000001', 'budget-worker-1', 1, 1,
      '[{
        "idempotencyKey":"89800000-0000-4000-8000-000000000001:attempt:1:model",
        "reason":"platform_model_usage","direction":"debit",
        "weightedTokens":12,"rawTokens":11,"costEstimate":0.000005,
        "currency":"USD","metadata":{"attempt":1,"costMicros":5}
      }]'::jsonb
    );
    raise exception 'conflicting accounting replay was accepted';
  exception when unique_violation then null;
  end;

  result := public.retry_job(
    '89800000-0000-4000-8000-000000000001', 'budget-worker-1', 1,
    'provider', 'provider_offline', 1
  );
  if result->>'retried' <> 'true' then raise exception 'retry failed: %', result; end if;
end;
$$;

select pg_sleep(1.1);

do $$
declare
  result jsonb;
  usage jsonb;
begin
  result := public.claim_next_job('budget-worker-2', array['budget_test'], 120);
  if result->>'acquired' <> 'true' or result->'job'->>'attempt' <> '2' then
    raise exception 'second budget fixture claim failed: %', result;
  end if;
  usage := result->'job'->'usage';
  if usage->>'rawTokens' <> '10'
     or usage->>'weightedTokens' <> '12'
     or usage->>'costMicros' <> '5'
     or usage->>'wallTimeMs' <> '25'
     or usage->>'sandboxTimeMs' <> '7'
     or usage->>'toolCalls' <> '2' then
    raise exception 'durable cumulative usage mismatch: %', usage;
  end if;

  result := public.record_job_accounting(
    '89800000-0000-4000-8000-000000000001', 'budget-worker-2', 2, 2,
    '[{
      "idempotencyKey":"89800000-0000-4000-8000-000000000001:attempt:2:resource",
      "reason":"job_resource_usage","direction":"debit",
      "weightedTokens":0,"rawTokens":0,"costEstimate":0,
      "currency":"USD","metadata":{"attempt":2,"wallTimeMs":9,"sandboxTimeMs":0,"toolCalls":0,"costMicros":0}
    }]'::jsonb
  );
  if result->>'recorded' <> 'true' then raise exception 'attempt 2 accounting failed: %', result; end if;
  result := public.finalize_job(
    '89800000-0000-4000-8000-000000000001', 'budget-worker-2', 2,
    'failed', '{}'::jsonb, 'policy', 'JOB_BUDGET_EXCEEDED'
  );
  if result->>'status' <> 'failed' then raise exception 'budget terminal failed: %', result; end if;

  result := public.record_job_accounting(
    '89800000-0000-4000-8000-000000000001', 'budget-worker-2', 2, 2,
    '[{
      "idempotencyKey":"89800000-0000-4000-8000-000000000001:attempt:2:resource",
      "reason":"job_resource_usage","direction":"debit",
      "weightedTokens":0,"rawTokens":0,"costEstimate":0,
      "currency":"USD","metadata":{"attempt":2,"wallTimeMs":9,"sandboxTimeMs":0,"toolCalls":0,"costMicros":0}
    }]'::jsonb
  );
  if result->>'recorded' <> 'true' or result->>'replayed' <> 'true' then
    raise exception 'terminal accounting replay failed: %', result;
  end if;
end;
$$;

reset role;

do $$
begin
  if (select count(*) from public.ledger_entries
      where job_id = '89800000-0000-4000-8000-000000000001') <> 3 then
    raise exception 'attempt ledger is incomplete or duplicated';
  end if;
end;
$$;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-4000-8000-000000000001';
do $$
begin
  begin
    perform public.record_job_accounting(
      '89800000-0000-4000-8000-000000000001', 'budget-worker-2', 2, 2,
      '[]'::jsonb
    );
    raise exception 'authenticated accounting execution succeeded';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.ledger_entries(
      principal_id, job_id, idempotency_key, reason
    ) values (
      '00000000-0000-4000-8000-000000000001',
      '89800000-0000-4000-8000-000000000001', 'forged', 'forged'
    );
    raise exception 'authenticated ledger insert succeeded';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset role;
