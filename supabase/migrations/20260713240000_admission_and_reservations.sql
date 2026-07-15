-- Atomic paid-work admission. A job row, its quota/balance reservation and the
-- balance hold either commit together or do not exist. Terminal settlement
-- refunds unused credit and makes legacy ledger debits reservation-aware.
begin;

alter table public.profiles
  add column if not exists limit_5h bigint,
  add column if not exists limit_week bigint,
  add column if not exists quota_version bigint not null default 0;

create table if not exists public.job_price_catalog (
  sku text not null,
  version integer not null check (version > 0),
  default_reserve_tokens bigint not null check (default_reserve_tokens >= 0),
  raw_token_cap bigint check (raw_token_cap is null or raw_token_cap > 0),
  token_multiplier_millis integer not null default 1000
    check (token_multiplier_millis between 0 and 10000),
  reserve_cost_micros bigint not null check (reserve_cost_micros >= 0),
  currency text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (sku, version),
  constraint job_price_catalog_sku_check
    check (sku ~ '^[a-z][a-z0-9_.-]{0,127}$')
);
create unique index if not exists job_price_catalog_one_active_sku_idx
  on public.job_price_catalog(sku) where active;

insert into public.job_price_catalog(
  sku, version, default_reserve_tokens, raw_token_cap,
  token_multiplier_millis, reserve_cost_micros, currency, active
) values
  ('chat.text',       1,  480000, 160000, 3000,  5000000, 'USD', true),
  ('chat.title',      1,   24576,   8192, 3000,   100000, 'USD', true),
  ('media.image',     1,  200000,   null,    0,   250000, 'USD', true),
  ('media.video',     1, 5000000,   null,    0, 10000000, 'USD', true),
  ('agent.task',      1,  480000, 160000, 3000, 10000000, 'USD', true),
  ('agent.operation', 1,       0,   null,    0,         0, 'USD', true),
  ('internal.default',1,       0,   null,    0,         0, 'USD', true)
on conflict (sku, version) do nothing;

-- A versioned quote is historical evidence. Replays may confirm the seed but
-- must never reinterpret an already issued reservation by rewriting version 1.
do $$
begin
  if exists (
    select 1
    from (values
      ('chat.text',       1,  480000::bigint, 160000::bigint, 3000,  5000000::bigint, 'USD', true),
      ('chat.title',      1,   24576::bigint,   8192::bigint, 3000,   100000::bigint, 'USD', true),
      ('media.image',     1,  200000::bigint,           null,    0,   250000::bigint, 'USD', true),
      ('media.video',     1, 5000000::bigint,           null,    0, 10000000::bigint, 'USD', true),
      ('agent.task',      1,  480000::bigint, 160000::bigint, 3000, 10000000::bigint, 'USD', true),
      ('agent.operation', 1,       0::bigint,           null,    0,         0::bigint, 'USD', true),
      ('internal.default',1,       0::bigint,           null,    0,         0::bigint, 'USD', true)
    ) as expected(
      sku, version, default_reserve_tokens, raw_token_cap,
      token_multiplier_millis, reserve_cost_micros, currency, active
    )
    join public.job_price_catalog as actual using (sku, version)
    where actual.default_reserve_tokens is distinct from expected.default_reserve_tokens
       or actual.raw_token_cap is distinct from expected.raw_token_cap
       or actual.token_multiplier_millis is distinct from expected.token_multiplier_millis
       or actual.reserve_cost_micros is distinct from expected.reserve_cost_micros
       or actual.currency is distinct from expected.currency
       or actual.active is distinct from expected.active
  ) then
    raise exception 'job_price_catalog_seed_conflict' using errcode = '23514';
  end if;
end;
$$;

create table if not exists public.job_admission_reservations (
  job_id uuid primary key,
  principal_id uuid not null references auth.users(id) on delete restrict,
  sku text not null,
  price_version integer not null,
  funding text not null check (funding in ('quota', 'balance', 'customer')),
  status text not null default 'held' check (status in ('held', 'settled', 'released')),
  reserved_tokens bigint not null check (reserved_tokens >= 0),
  reserved_cost_micros bigint not null check (reserved_cost_micros >= 0),
  actual_tokens bigint not null default 0 check (actual_tokens >= 0),
  actual_cost_micros bigint not null default 0 check (actual_cost_micros >= 0),
  released_tokens bigint not null default 0 check (released_tokens >= 0),
  release_reason text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  settled_at timestamptz,
  constraint job_admission_reservations_job_fk
    foreign key (job_id) references public.jobs(id) on delete restrict
    deferrable initially deferred,
  constraint job_admission_reservations_price_fk
    foreign key (sku, price_version) references public.job_price_catalog(sku, version),
  constraint job_admission_reservations_terminal_check check (
    (status = 'held' and settled_at is null)
    or (status in ('settled', 'released') and settled_at is not null)
  )
);
create index if not exists job_admission_reservations_principal_held_idx
  on public.job_admission_reservations(principal_id, created_at)
  where status = 'held';

alter table public.job_price_catalog enable row level security;
alter table public.job_admission_reservations enable row level security;
revoke all on table public.job_price_catalog, public.job_admission_reservations
  from public, anon, authenticated, service_role;
grant select on table public.job_price_catalog, public.job_admission_reservations
  to service_role;

create or replace function public.reserve_job_admission()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sku text;
  v_price public.job_price_catalog%rowtype;
  v_funding text := 'quota';
  v_billing_class text := coalesce(new.payload->>'billingClass', 'platform');
  v_reserve_tokens bigint := 0;
  v_reserve_cost_micros bigint := 0;
  v_raw_limit bigint;
  v_balance bigint := 0;
  v_tokens_5h bigint := 0;
  v_tokens_7d bigint := 0;
  v_held_tokens bigint := 0;
  v_limit_5h bigint := 500000;
  v_limit_7d bigint := 10000000;
  v_wall_time_ms bigint := 3600000;
  v_now timestamptz := clock_timestamp();
begin
  v_sku := case
    when new.type = 'chat.generation' and new.payload->>'outputKind' = 'image' then 'media.image'
    when new.type = 'chat.generation' and new.payload->>'outputKind' = 'video' then 'media.video'
    when new.type = 'chat.generation' then 'chat.text'
    when new.type = 'chat.title' then 'chat.title'
    when new.type = 'agent.task' then 'agent.task'
    when new.type = 'agent.operation' then 'agent.operation'
    else 'internal.default'
  end;

  select * into strict v_price from public.job_price_catalog
  where sku = v_sku and active;

  if v_price.raw_token_cap is not null then
    if coalesce(new.budget->>'tokenLimit', '') ~ '^[0-9]{1,13}$' then
      v_raw_limit := least((new.budget->>'tokenLimit')::bigint, v_price.raw_token_cap);
    else
      v_raw_limit := v_price.raw_token_cap;
    end if;
    new.budget := jsonb_set(new.budget, '{tokenLimit}', to_jsonb(v_raw_limit), true);
    v_reserve_tokens := greatest(
      v_price.default_reserve_tokens,
      (v_raw_limit * v_price.token_multiplier_millis + 999) / 1000
    );
  else
    v_reserve_tokens := v_price.default_reserve_tokens;
  end if;
  v_reserve_cost_micros := v_price.reserve_cost_micros;

  if v_billing_class = 'customer' then
    v_funding := 'customer';
    v_reserve_tokens := 0;
    v_reserve_cost_micros := 0;
  elsif v_billing_class <> 'platform' then
    raise exception 'invalid_job_billing_class' using errcode = '22023';
  end if;

  insert into public.profiles(user_id, balance)
  values (new.principal_id, 0)
  on conflict (user_id) do nothing;
  select greatest(coalesce(balance, 0), 0)::bigint,
         greatest(coalesce(limit_5h, 500000), 0)::bigint,
         greatest(coalesce(limit_week, 10000000), 0)::bigint
  into v_balance, v_limit_5h, v_limit_7d
  from public.profiles where user_id = new.principal_id for update;

  if v_funding <> 'customer' and v_reserve_tokens > 0 then
    select
      greatest(coalesce(sum(case when created_at >= v_now - interval '5 hours'
        then case direction when 'debit' then weighted_tokens else -weighted_tokens end
        else 0 end), 0), 0)::bigint,
      greatest(coalesce(sum(case when created_at >= v_now - interval '7 days'
        then case direction when 'debit' then weighted_tokens else -weighted_tokens end
        else 0 end), 0), 0)::bigint
    into v_tokens_5h, v_tokens_7d
    from public.ledger_entries where principal_id = new.principal_id;
    select coalesce(sum(reserved_tokens), 0)::bigint into v_held_tokens
    from public.job_admission_reservations
    where principal_id = new.principal_id and status = 'held' and funding = 'quota';

    if v_tokens_5h + v_held_tokens + v_reserve_tokens > v_limit_5h
       or v_tokens_7d + v_held_tokens + v_reserve_tokens > v_limit_7d then
      v_funding := 'balance';
      if v_balance < v_reserve_tokens then
        raise exception 'insufficient_job_credit'
          using errcode = 'P0001',
                detail = 'Atomic admission requires the full maximum-cost reservation.';
      end if;
      update public.profiles set
        balance = v_balance - v_reserve_tokens,
        quota_version = coalesce(quota_version, 0) + 1
      where user_id = new.principal_id;
    end if;
  end if;

  if coalesce(new.budget->>'wallTimeMs', '') ~ '^[0-9]{1,13}$' then
    v_wall_time_ms := least((new.budget->>'wallTimeMs')::bigint, 86400000);
  end if;
  insert into public.job_admission_reservations(
    job_id, principal_id, sku, price_version, funding, status,
    reserved_tokens, reserved_cost_micros, created_at, expires_at
  ) values (
    new.id, new.principal_id, v_sku, v_price.version, v_funding, 'held',
    v_reserve_tokens, v_reserve_cost_micros, v_now,
    v_now + make_interval(secs => ((v_wall_time_ms + 3600000) / 1000)::double precision)
  );

  new.payload := new.payload || jsonb_build_object('admission', jsonb_build_object(
    'schemaVersion', 1,
    'funding', v_funding,
    'sku', v_sku,
    'priceVersion', v_price.version,
    'reservedTokens', v_reserve_tokens,
    'reservedCostMicros', v_reserve_cost_micros
  ));
  return new;
end;
$$;

drop trigger if exists jobs_reserve_admission on public.jobs;
create trigger jobs_reserve_admission
before insert on public.jobs
for each row execute function public.reserve_job_admission();
revoke all on function public.reserve_job_admission()
  from public, anon, authenticated, service_role;

create or replace function public.settle_job_admission(input_job_id uuid, input_reason text default 'terminal')
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reservation public.job_admission_reservations%rowtype;
  v_job public.jobs%rowtype;
  v_actual_tokens bigint := 0;
  v_actual_cost_micros bigint := 0;
  v_release bigint := 0;
  v_balance bigint := 0;
  v_status text;
  v_now timestamptz := clock_timestamp();
begin
  select * into v_reservation from public.job_admission_reservations
  where job_id = input_job_id for update;
  if not found then
    return jsonb_build_object('settled', false, 'replayed', false, 'reason', 'not_reserved');
  end if;
  if v_reservation.status <> 'held' then
    return jsonb_build_object(
      'settled', true, 'replayed', true, 'status', v_reservation.status,
      'actualTokens', v_reservation.actual_tokens,
      'releasedTokens', v_reservation.released_tokens
    );
  end if;
  select * into strict v_job from public.jobs where id = input_job_id for update;
  if v_job.status not in ('completed', 'failed', 'cancelled') then
    return jsonb_build_object('settled', false, 'replayed', false, 'reason', 'job_not_terminal');
  end if;

  select
    greatest(coalesce(sum(case direction when 'debit' then weighted_tokens else -weighted_tokens end), 0), 0)::bigint,
    greatest(coalesce(sum(case direction when 'debit' then round(cost_estimate * 1000000)
      else -round(cost_estimate * 1000000) end), 0), 0)::bigint
  into v_actual_tokens, v_actual_cost_micros
  from public.ledger_entries where job_id = input_job_id;

  if v_actual_tokens > v_reservation.reserved_tokens
     or v_actual_cost_micros > v_reservation.reserved_cost_micros then
    raise exception 'job_admission_overage'
      using errcode = '23514',
            detail = 'Recorded usage exceeded the atomically authorized maximum.';
  end if;
  v_release := v_reservation.reserved_tokens - v_actual_tokens;
  if v_reservation.funding = 'balance' then
    select greatest(coalesce(balance, 0), 0)::bigint into v_balance
    from public.profiles where user_id = v_reservation.principal_id for update;
    update public.profiles set
      balance = v_balance + v_release,
      quota_version = coalesce(quota_version, 0) + 1
    where user_id = v_reservation.principal_id
    returning balance::bigint into v_balance;
    update public.ledger_balance_settlements settlement set
      debited_tokens = settlement.requested_tokens,
      remaining_balance = v_balance
    where settlement.ledger_entry_id in (
      select id from public.ledger_entries where job_id = input_job_id
    );
  end if;

  v_status := case when v_actual_tokens = 0 and v_actual_cost_micros = 0
    then 'released' else 'settled' end;
  update public.job_admission_reservations set
    status = v_status,
    actual_tokens = v_actual_tokens,
    actual_cost_micros = v_actual_cost_micros,
    released_tokens = v_release,
    release_reason = left(coalesce(input_reason, 'terminal'), 200),
    settled_at = v_now
  where job_id = input_job_id;
  return jsonb_build_object(
    'settled', true, 'replayed', false, 'status', v_status,
    'funding', v_reservation.funding,
    'actualTokens', v_actual_tokens,
    'actualCostMicros', v_actual_cost_micros,
    'releasedTokens', v_release
  );
end;
$$;

create or replace function public.release_job_admission_reservation(
  input_job_id uuid,
  input_reason text default 'released'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return public.settle_job_admission(input_job_id, input_reason);
end;
$$;

create or replace function public.settle_job_admission_on_terminal()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status in ('completed', 'failed', 'cancelled')
     and (tg_op = 'INSERT' or old.status not in ('completed', 'failed', 'cancelled')) then
    perform public.settle_job_admission(new.id, 'job.' || new.status);
  end if;
  return null;
end;
$$;

drop trigger if exists jobs_settle_admission on public.jobs;
create trigger jobs_settle_admission
after insert or update of status on public.jobs
for each row execute function public.settle_job_admission_on_terminal();

revoke all on function public.settle_job_admission(uuid,text),
  public.release_job_admission_reservation(uuid,text),
  public.settle_job_admission_on_terminal()
  from public, anon, authenticated, service_role;
grant execute on function public.settle_job_admission(uuid,text),
  public.release_job_admission_reservation(uuid,text)
  to service_role;

-- A reservation-funded ledger entry was already held at admission. Preserve
-- legacy post-paid behavior only for jobs created before this contract.
create or replace function public.settle_ledger_balance_debit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reservation public.job_admission_reservations%rowtype;
  v_balance bigint := 0;
  v_debit bigint := 0;
begin
  if new.direction <> 'debit' or new.weighted_tokens <= 0 then return new; end if;
  select * into v_reservation from public.job_admission_reservations
  where job_id = new.job_id;
  if found then
    if v_reservation.principal_id is distinct from new.principal_id then
      raise exception 'job_admission_principal_mismatch' using errcode = '23514';
    end if;
    if v_reservation.funding = 'balance' then
      select greatest(coalesce(balance, 0), 0)::bigint into v_balance
      from public.profiles where user_id = new.principal_id;
      insert into public.ledger_balance_settlements(
        ledger_entry_id, principal_id, requested_tokens,
        debited_tokens, remaining_balance, created_at
      ) values (
        new.id, new.principal_id, new.weighted_tokens, 0, v_balance, clock_timestamp()
      ) on conflict (ledger_entry_id) do nothing;
    end if;
    return new;
  end if;

  if coalesce(new.metadata->>'usingBalance', 'false') <> 'true' then return new; end if;
  insert into public.profiles(user_id, balance)
  values (new.principal_id, 0) on conflict (user_id) do nothing;
  select greatest(coalesce(balance, 0), 0)::bigint into v_balance
  from public.profiles where user_id = new.principal_id for update;
  v_debit := least(v_balance, new.weighted_tokens);
  update public.profiles set
    balance = v_balance - v_debit,
    quota_version = coalesce(quota_version, 0) + 1
  where user_id = new.principal_id;
  insert into public.ledger_balance_settlements(
    ledger_entry_id, principal_id, requested_tokens,
    debited_tokens, remaining_balance, created_at
  ) values (
    new.id, new.principal_id, new.weighted_tokens,
    v_debit, v_balance - v_debit, clock_timestamp()
  );
  return new;
end;
$$;

-- Quota reads expose available balance after holds and report in-flight quota
-- reservations separately. Admission itself remains the authoritative decision.
create or replace function public.get_ledger_quota_status(input_principal_id uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  v_tokens_5h bigint := 0;
  v_tokens_7d bigint := 0;
  v_balance bigint := 0;
  v_held_quota bigint := 0;
  v_held_balance bigint := 0;
  v_limit_5h bigint := 500000;
  v_limit_7d bigint := 10000000;
begin
  if input_principal_id is null
     or (auth.uid() is not null and auth.uid() <> input_principal_id) then
    raise exception 'quota_principal_forbidden' using errcode = '42501';
  end if;
  select
    greatest(coalesce(sum(case when created_at >= now() - interval '5 hours'
      then case direction when 'debit' then weighted_tokens else -weighted_tokens end
      else 0 end), 0), 0)::bigint,
    greatest(coalesce(sum(case when created_at >= now() - interval '7 days'
      then case direction when 'debit' then weighted_tokens else -weighted_tokens end
      else 0 end), 0), 0)::bigint
  into v_tokens_5h, v_tokens_7d
  from public.ledger_entries where principal_id = input_principal_id;
  select greatest(coalesce(balance, 0), 0)::bigint,
         greatest(coalesce(limit_5h, 500000), 0)::bigint,
         greatest(coalesce(limit_week, 10000000), 0)::bigint
  into v_balance, v_limit_5h, v_limit_7d
  from public.profiles where user_id = input_principal_id;
  select
    coalesce(sum(reserved_tokens) filter (where funding = 'quota'), 0)::bigint,
    coalesce(sum(reserved_tokens) filter (where funding = 'balance'), 0)::bigint
  into v_held_quota, v_held_balance
  from public.job_admission_reservations
  where principal_id = input_principal_id and status = 'held';
  return jsonb_build_object(
    'tokens5h', v_tokens_5h,
    'tokens7d', v_tokens_7d,
    'balance', v_balance,
    'reservedQuotaTokens', v_held_quota,
    'reservedBalanceTokens', v_held_balance,
    'limit5h', v_limit_5h,
    'limit7d', v_limit_7d
  );
end;
$$;
revoke all on function public.get_ledger_quota_status(uuid) from public, anon;
grant execute on function public.get_ledger_quota_status(uuid) to authenticated, service_role;

-- Browser JWTs may no longer bypass HTTP admission or mutate worker authority.
revoke all on function public.enqueue_agent_task_job(
  uuid,uuid,text,text,uuid,uuid,uuid,uuid,text,text,text,jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.enqueue_agent_task_job(
  uuid,uuid,text,text,uuid,uuid,uuid,uuid,text,text,text,jsonb
) to service_role;
revoke all on function public.enqueue_agent_operation(
  uuid,uuid,uuid,text,text,text,uuid,text,text,text,jsonb,text,text
) from public, anon, authenticated, service_role;
grant execute on function public.enqueue_agent_operation(
  uuid,uuid,uuid,text,text,text,uuid,text,text,text,jsonb,text,text
) to service_role;

create or replace function public.merge_agent_task_meta(
  input_task_id uuid,
  patch jsonb default '{}'::jsonb,
  remove_keys text[] default '{}'::text[]
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_merged jsonb;
begin
  if octet_length(coalesce(patch, '{}'::jsonb)::text) > 2097152
     or coalesce(array_length(remove_keys, 1), 0) > 100 then
    raise exception 'meta_patch_too_large' using errcode = '22023';
  end if;
  update public.agent_tasks set
    meta = (coalesce(meta, '{}'::jsonb) - remove_keys) || coalesce(patch, '{}'::jsonb),
    updated_at = clock_timestamp()
  where id = input_task_id returning meta into v_merged;
  if not found then raise exception 'task_not_found' using errcode = 'P0002'; end if;
  return v_merged;
end;
$$;

create or replace function public.merge_agent_run_state(input_task_id uuid, patch jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_merged jsonb;
begin
  if octet_length(coalesce(patch, '{}'::jsonb)::text) > 1048576 then
    raise exception 'run_state_too_large' using errcode = '22023';
  end if;
  update public.agent_tasks set
    meta = jsonb_set(
      coalesce(meta, '{}'::jsonb), '{agentRun}',
      coalesce(meta->'agentRun', '{}'::jsonb) || coalesce(patch, '{}'::jsonb), true
    ),
    updated_at = clock_timestamp()
  where id = input_task_id returning meta->'agentRun' into v_merged;
  if not found then raise exception 'task_not_found' using errcode = 'P0002'; end if;
  return v_merged;
end;
$$;

revoke all on function public.merge_agent_task_meta(uuid,jsonb,text[])
  from public, anon, authenticated, service_role;
revoke all on function public.merge_agent_run_state(uuid,jsonb)
  from public, anon, authenticated, service_role;
do $$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'public.claim_agent_run(uuid,text,integer)',
    'public.renew_agent_run(uuid,text,integer)',
    'public.release_agent_run(uuid,text)'
  ] loop
    if to_regprocedure(v_signature) is not null then
      execute format(
        'revoke all on function %s from public, anon, authenticated, service_role',
        v_signature
      );
    end if;
  end loop;
end;
$$;
grant execute on function public.merge_agent_task_meta(uuid,jsonb,text[]),
  public.merge_agent_run_state(uuid,jsonb)
  to service_role;

commit;
