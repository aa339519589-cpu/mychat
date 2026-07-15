begin;

-- Budgets are an execution contract, not advisory JSON. Keep the shape strict at
-- the database boundary so every worker sees safe integer limits.
create or replace function public.assert_job_budget(input_budget jsonb)
returns void
language plpgsql
set search_path = public, pg_temp
as $$
declare
  budget jsonb := coalesce(input_budget, '{}'::jsonb);
  budget_name text;
  budget_maximum numeric;
  budget_text text;
begin
  if jsonb_typeof(budget) <> 'object' then
    raise exception 'invalid_job_budget' using errcode = '22023';
  end if;
  for budget_name, budget_maximum in
    select * from (values
      ('wallTimeMs', 86400000::numeric),
      ('tokenLimit', 1000000000::numeric),
      ('costMicros', 1000000000000::numeric),
      ('sandboxTimeMs', 86400000::numeric),
      ('toolCallLimit', 1000000::numeric)
    ) as limits(name, maximum)
  loop
    if not (budget ? budget_name) then continue; end if;
    budget_text := budget->>budget_name;
    if jsonb_typeof(budget->budget_name) <> 'number'
       or budget_text !~ '^[0-9]{1,13}$' then
      raise exception 'invalid_job_budget' using errcode = '22023';
    end if;
    if budget_text::numeric not between 1 and budget_maximum then
      raise exception 'invalid_job_budget' using errcode = '22023';
    end if;
  end loop;
  if (budget ? 'wallTimeMs') and (budget ? 'sandboxTimeMs')
     and (budget->>'sandboxTimeMs')::bigint > (budget->>'wallTimeMs')::bigint then
    raise exception 'invalid_job_budget' using errcode = '22023';
  end if;
end;
$$;

create or replace function public.validate_job_budget()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  perform public.assert_job_budget(new.budget);
  return new;
end;
$$;

do $$
declare
  job_budget jsonb;
begin
  for job_budget in select budget from public.jobs loop
    perform public.assert_job_budget(job_budget);
  end loop;
end;
$$;

drop trigger if exists jobs_validate_budget on public.jobs;
create trigger jobs_validate_budget
before insert or update of budget on public.jobs
for each row execute function public.validate_job_budget();

revoke all on function public.validate_job_budget() from public, anon, authenticated, service_role;
revoke all on function public.assert_job_budget(jsonb) from public, anon, authenticated, service_role;

-- Every attempt writes usage before retry/finalize. The fence makes a dead
-- worker unable to charge, while deterministic attempt keys make an uncertain
-- RPC response safe to replay.
create or replace function public.record_job_accounting(
  input_job_id uuid,
  input_worker_id text,
  input_lease_version bigint,
  input_attempt integer,
  input_ledger_entries jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_job public.jobs%rowtype;
  existing_ledger public.ledger_entries%rowtype;
  ledger_item jsonb;
  normalized_ledger jsonb := coalesce(input_ledger_entries, '[]'::jsonb);
  v_now timestamptz := clock_timestamp();
  all_existed boolean := true;
  ledger_direction text;
  ledger_weighted bigint;
  ledger_raw bigint;
  ledger_cost numeric(20, 8);
  ledger_currency text;
  ledger_metadata jsonb;
begin
  if input_job_id is null or input_worker_id is null
     or length(input_worker_id) not between 1 and 256
     or input_lease_version is null or input_lease_version < 1
     or input_attempt is null or input_attempt < 1
     or jsonb_typeof(normalized_ledger) <> 'array'
     or jsonb_array_length(normalized_ledger) not between 1 and 32
     or octet_length(normalized_ledger::text) > 1048576
     or exists (
       select 1 from jsonb_array_elements(normalized_ledger) as entry(item)
       where jsonb_typeof(entry.item) <> 'object'
          or length(coalesce(entry.item->>'idempotencyKey', '')) not between 1 and 300
          or length(coalesce(entry.item->>'reason', '')) not between 1 and 200
          or coalesce(entry.item->>'direction', 'debit') not in ('debit', 'credit')
          or coalesce(entry.item->>'weightedTokens', '0') !~ '^[0-9]{1,19}$'
          or coalesce(entry.item->>'rawTokens', '0') !~ '^[0-9]{1,19}$'
          or coalesce(entry.item->>'costEstimate', '0') !~ '^[0-9]{1,12}(\.[0-9]{1,8})?$'
          or coalesce(entry.item->>'currency', 'USD') !~ '^[A-Z]{3}$'
          or length(coalesce(entry.item->>'model', '')) > 256
          or length(coalesce(entry.item->>'provider', '')) > 256
          or (entry.item ? 'metadata' and jsonb_typeof(entry.item->'metadata') <> 'object')
          or coalesce(entry.item->'metadata'->>'attempt', '') <> input_attempt::text
     ) then
    raise exception 'invalid_job_accounting' using errcode = '22023';
  end if;

  select * into current_job from public.jobs where id = input_job_id for update;
  if not found then
    return jsonb_build_object(
      'recorded', false, 'replayed', false, 'reason', 'not_found',
      'status', null, 'cancelRequested', false
    );
  end if;
  if current_job.attempt <> input_attempt then
    return jsonb_build_object(
      'recorded', false, 'replayed', false, 'reason', 'stale_attempt',
      'status', current_job.status,
      'cancelRequested', current_job.cancel_requested_at is not null
    );
  end if;

  for ledger_item in select value from jsonb_array_elements(normalized_ledger)
  loop
    if position(
      current_job.id::text || ':attempt:' || input_attempt::text || ':'
      in ledger_item->>'idempotencyKey'
    ) <> 1 then
      raise exception 'invalid_job_accounting_key' using errcode = '22023';
    end if;
    ledger_direction := coalesce(ledger_item->>'direction', 'debit');
    ledger_weighted := coalesce((ledger_item->>'weightedTokens')::bigint, 0);
    ledger_raw := coalesce((ledger_item->>'rawTokens')::bigint, 0);
    ledger_cost := coalesce((ledger_item->>'costEstimate')::numeric, 0);
    ledger_currency := coalesce(ledger_item->>'currency', 'USD');
    ledger_metadata := coalesce(ledger_item->'metadata', '{}'::jsonb);
    select * into existing_ledger
    from public.ledger_entries
    where principal_id = current_job.principal_id
      and idempotency_key = ledger_item->>'idempotencyKey'
    for key share;
    if found and (
      existing_ledger.job_id <> current_job.id
      or existing_ledger.reason <> ledger_item->>'reason'
      or existing_ledger.direction <> ledger_direction
      or existing_ledger.weighted_tokens <> ledger_weighted
      or existing_ledger.raw_tokens <> ledger_raw
      or existing_ledger.model is distinct from nullif(ledger_item->>'model', '')
      or existing_ledger.provider is distinct from nullif(ledger_item->>'provider', '')
      or existing_ledger.cost_estimate <> ledger_cost
      or existing_ledger.currency <> ledger_currency
      or existing_ledger.metadata <> ledger_metadata
    ) then
      raise exception 'ledger_idempotency_conflict' using errcode = '23505';
    end if;
    if not found then all_existed := false; end if;
  end loop;

  if current_job.status in ('completed', 'failed', 'cancelled') then
    return jsonb_build_object(
      'recorded', all_existed, 'replayed', all_existed,
      'reason', case when all_existed then null else 'terminal' end,
      'status', current_job.status, 'cancelRequested', false
    );
  end if;
  if current_job.lease_owner is distinct from input_worker_id
     or current_job.lease_version <> input_lease_version
     or current_job.lease_expires_at is null
     or current_job.lease_expires_at <= v_now then
    return jsonb_build_object(
      'recorded', false, 'replayed', false, 'reason', 'stale_fence',
      'status', current_job.status,
      'cancelRequested', current_job.cancel_requested_at is not null
    );
  end if;

  for ledger_item in select value from jsonb_array_elements(normalized_ledger)
  loop
    insert into public.ledger_entries(
      principal_id, job_id, idempotency_key, reason, direction,
      weighted_tokens, raw_tokens, model, provider, cost_estimate,
      currency, metadata, created_at
    ) values (
      current_job.principal_id,
      current_job.id,
      ledger_item->>'idempotencyKey',
      ledger_item->>'reason',
      coalesce(ledger_item->>'direction', 'debit'),
      coalesce((ledger_item->>'weightedTokens')::bigint, 0),
      coalesce((ledger_item->>'rawTokens')::bigint, 0),
      nullif(ledger_item->>'model', ''),
      nullif(ledger_item->>'provider', ''),
      coalesce((ledger_item->>'costEstimate')::numeric, 0),
      coalesce(ledger_item->>'currency', 'USD'),
      coalesce(ledger_item->'metadata', '{}'::jsonb),
      v_now
    ) on conflict (principal_id, idempotency_key) do nothing;
  end loop;

  return jsonb_build_object(
    'recorded', true, 'replayed', all_existed, 'reason', null,
    'status', current_job.status,
    'cancelRequested', current_job.cancel_requested_at is not null
  );
end;
$$;

revoke all on function public.record_job_accounting(uuid,text,bigint,integer,jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.record_job_accounting(uuid,text,bigint,integer,jsonb)
  to service_role;

-- Claims include durable usage from prior attempts so budgets are job-wide,
-- rather than resetting whenever a lease is recovered.
create or replace function public.job_contract_json(input_job public.jobs)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'id', input_job.id,
    'type', input_job.type,
    'queue', input_job.queue,
    'principalId', input_job.principal_id,
    'authClass', input_job.auth_class,
    'subject', input_job.subject,
    'inputHash', input_job.input_hash,
    'payload', input_job.payload,
    'budget', input_job.budget,
    'usage', (
      select jsonb_build_object(
        'wallTimeMs', coalesce(sum(case when coalesce(entry.metadata->>'wallTimeMs', '') ~ '^[0-9]{1,15}$'
          then (entry.metadata->>'wallTimeMs')::bigint else 0 end), 0),
        'rawTokens', coalesce(sum(entry.raw_tokens), 0),
        'weightedTokens', coalesce(sum(entry.weighted_tokens), 0),
        'costMicros', coalesce(sum(round(entry.cost_estimate * 1000000)), 0),
        'sandboxTimeMs', coalesce(sum(case when coalesce(entry.metadata->>'sandboxTimeMs', '') ~ '^[0-9]{1,15}$'
          then (entry.metadata->>'sandboxTimeMs')::bigint else 0 end), 0),
        'toolCalls', coalesce(sum(case when coalesce(entry.metadata->>'toolCalls', '') ~ '^[0-9]{1,15}$'
          then (entry.metadata->>'toolCalls')::bigint else 0 end), 0)
      )
      from public.ledger_entries as entry
      where entry.job_id = input_job.id
        and entry.direction = 'debit'
    ),
    'status', input_job.status,
    'attempt', input_job.attempt,
    'maxAttempts', input_job.max_attempts,
    'priority', input_job.priority,
    'availableAt', input_job.available_at,
    'leaseOwner', input_job.lease_owner,
    'leaseVersion', input_job.lease_version,
    'leaseExpiresAt', input_job.lease_expires_at,
    'cancelRequestedAt', input_job.cancel_requested_at,
    'cancelReason', input_job.cancel_reason,
    'progress', input_job.progress,
    'result', input_job.result,
    'errorClass', input_job.error_class,
    'errorCode', input_job.error_code,
    'eventSeq', input_job.event_sequence,
    'checkpoint', (
      select jsonb_build_object(
        'version', checkpoint.version,
        'phase', checkpoint.phase,
        'data', checkpoint.checkpoint,
        'progress', checkpoint.progress,
        'resumable', checkpoint.resumable,
        'leaseVersion', checkpoint.lease_version,
        'updatedAt', checkpoint.updated_at
      )
      from public.job_checkpoints as checkpoint
      where checkpoint.job_id = input_job.id
    ),
    'createdAt', input_job.created_at,
    'updatedAt', input_job.updated_at,
    'startedAt', input_job.started_at,
    'terminalAt', input_job.terminal_at
  );
$$;

revoke all on function public.job_contract_json(public.jobs)
  from public, anon, authenticated, service_role;

create or replace function public.runtime_healthcheck_v7()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.runtime_healthcheck_v6()
    and to_regprocedure('public.record_job_accounting(uuid,text,bigint,integer,jsonb)') is not null
    and exists (
      select 1 from pg_trigger
      where tgrelid = 'public.jobs'::regclass
        and tgname = 'jobs_validate_budget'
        and not tgisinternal
    )
    and has_function_privilege(
      'service_role',
      'public.record_job_accounting(uuid,text,bigint,integer,jsonb)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'public.record_job_accounting(uuid,text,bigint,integer,jsonb)',
      'EXECUTE'
    );
$$;

revoke all on function public.runtime_healthcheck_v7()
  from public, anon, authenticated, service_role;
grant execute on function public.runtime_healthcheck_v7() to service_role;

commit;
