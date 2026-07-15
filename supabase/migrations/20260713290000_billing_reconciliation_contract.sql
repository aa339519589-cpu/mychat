-- Immutable pricing evidence, reservation quote snapshots, double-entry-style
-- balance allocation receipts, and bounded authoritative reconciliation.
begin;

create extension if not exists pgcrypto;

-- Catalog rows never change. A forward-only activation log selects the price
-- used for new admissions without rewriting historical versions.
create table if not exists public.job_price_activations (
  activation_id bigint generated always as identity primary key,
  sku text not null,
  price_version integer not null,
  activation_generation bigint not null default 1
    check (activation_generation > 0),
  activated_at timestamptz not null default now(),
  activated_by text not null default 'migration'
    check (length(activated_by) between 1 and 200),
  constraint job_price_activations_price_fkey
    foreign key (sku, price_version)
    references public.job_price_catalog(sku, version)
    on delete restrict,
  unique (sku, price_version)
);
alter table public.job_price_activations
  add column if not exists activation_generation bigint;
with numbered as (
  select activation_id,
         row_number() over (
           partition by sku order by activation_id
         )::bigint as generation
  from public.job_price_activations
)
update public.job_price_activations as activation
set activation_generation = numbered.generation
from numbered
where activation.activation_id = numbered.activation_id
  and activation.activation_generation is null;
alter table public.job_price_activations
  alter column activation_generation set default 1,
  alter column activation_generation set not null;
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.job_price_activations'::regclass
      and conname = 'job_price_activations_generation_check'
  ) then
    alter table public.job_price_activations
      add constraint job_price_activations_generation_check
      check (activation_generation > 0);
  end if;
end;
$$;
create index if not exists job_price_activations_current_idx
  on public.job_price_activations(sku, activation_generation desc);
create unique index if not exists job_price_activations_generation_key
  on public.job_price_activations(sku, activation_generation);

-- The mutable head is the serialization point; the activation rows remain the
-- immutable evidence. A row CAS is snapshot-safe even when activation is called
-- from an outer statement whose MVCC snapshot predates a concurrent winner.
create table if not exists public.job_price_activation_heads (
  sku text primary key,
  price_version integer not null,
  activation_generation bigint not null check (activation_generation > 0),
  change_token uuid not null,
  advanced_at timestamptz not null default clock_timestamp(),
  constraint job_price_activation_heads_price_fkey
    foreign key (sku, price_version)
    references public.job_price_catalog(sku, version)
    on delete restrict
);

alter table public.job_price_activations enable row level security;
alter table public.job_price_activation_heads enable row level security;
revoke all on table public.job_price_activations
  from public, anon, authenticated, service_role;
revoke all on table public.job_price_activation_heads
  from public, anon, authenticated, service_role;
grant select on table public.job_price_activations to service_role;
grant select on table public.job_price_activation_heads to service_role;

insert into public.job_price_activation_heads(
  sku, price_version, activation_generation, change_token, advanced_at
)
select distinct on (sku)
  sku, price_version, activation_generation, gen_random_uuid(), activated_at
from public.job_price_activations
order by sku, activation_generation desc, activation_id desc
on conflict (sku) do update set
  price_version = excluded.price_version,
  activation_generation = excluded.activation_generation,
  change_token = excluded.change_token,
  advanced_at = excluded.advanced_at
where excluded.activation_generation
  > public.job_price_activation_heads.activation_generation;

insert into public.job_price_activations(
  sku, price_version, activation_generation, activated_by
)
select sku, version, 1, '132900.initial-catalog'
from public.job_price_catalog
where active
on conflict (sku, price_version) do nothing;

insert into public.job_price_activation_heads(
  sku, price_version, activation_generation, change_token, advanced_at
)
select distinct on (sku)
  sku, price_version, activation_generation, gen_random_uuid(), activated_at
from public.job_price_activations
order by sku, activation_generation desc, activation_id desc
on conflict (sku) do update set
  price_version = excluded.price_version,
  activation_generation = excluded.activation_generation,
  change_token = excluded.change_token,
  advanced_at = excluded.advanced_at
where excluded.activation_generation
  > public.job_price_activation_heads.activation_generation;

create or replace function public.enforce_job_price_catalog_append_only()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  existing public.job_price_catalog%rowtype;
begin
  if tg_op <> 'INSERT' then
    raise exception 'job_price_catalog_is_append_only' using errcode = '55000';
  end if;

  select * into existing
  from public.job_price_catalog
  where sku = new.sku and version = new.version;
  if found then
    if existing.default_reserve_tokens is distinct from new.default_reserve_tokens
       or existing.raw_token_cap is distinct from new.raw_token_cap
       or existing.token_multiplier_millis is distinct from new.token_multiplier_millis
       or existing.reserve_cost_micros is distinct from new.reserve_cost_micros
       or existing.currency is distinct from new.currency
       or existing.active is distinct from new.active then
      raise exception 'job_price_catalog_version_conflict' using errcode = '23514';
    end if;
    -- Makes a replayed INSERT ... ON CONFLICT safe without executing an UPDATE.
    return null;
  end if;
  if new.active then
    raise exception 'job_price_catalog_active_flag_is_legacy' using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function public.enforce_job_price_activation_append_only()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  requested_token uuid := gen_random_uuid();
  observed public.job_price_activation_heads%rowtype;
begin
  if tg_op <> 'INSERT' then
    raise exception 'job_price_activations_is_append_only' using errcode = '55000';
  end if;

  insert into public.job_price_activation_heads as head(
    sku, price_version, activation_generation, change_token, advanced_at
  ) values (
    new.sku, new.price_version, 1, requested_token, clock_timestamp()
  )
  on conflict (sku) do update set
    price_version = case
      when excluded.price_version > head.price_version
        then excluded.price_version else head.price_version end,
    activation_generation = case
      when excluded.price_version > head.price_version
        then head.activation_generation + 1 else head.activation_generation end,
    change_token = case
      when excluded.price_version > head.price_version
        then excluded.change_token else head.change_token end,
    advanced_at = case
      when excluded.price_version > head.price_version
        then excluded.advanced_at else head.advanced_at end
  returning * into observed;

  if observed.price_version > new.price_version then
    raise exception 'job_price_activation_must_move_forward' using errcode = '23514';
  end if;
  if observed.change_token <> requested_token then
    return null;
  end if;
  new.activation_generation := observed.activation_generation;
  return new;
end;
$$;

drop trigger if exists job_price_catalog_append_only on public.job_price_catalog;
create trigger job_price_catalog_append_only
before insert or update or delete on public.job_price_catalog
for each row execute function public.enforce_job_price_catalog_append_only();
drop trigger if exists job_price_activations_append_only on public.job_price_activations;
create trigger job_price_activations_append_only
before insert or update or delete on public.job_price_activations
for each row execute function public.enforce_job_price_activation_append_only();

revoke all on function public.enforce_job_price_catalog_append_only(),
  public.enforce_job_price_activation_append_only()
  from public, anon, authenticated, service_role;

-- jsonb::text has a deterministic canonical key order inside one PostgreSQL
-- major contract. The schema version is part of the payload; changing the
-- canonical representation requires a new quote schema and hash algorithm.
create or replace function public.job_price_quote_hash(input_quote jsonb)
returns text
language sql
immutable
strict
set search_path = public, pg_temp
as $$
  select encode(digest(convert_to(input_quote::text, 'UTF8'), 'sha256'), 'hex');
$$;

create or replace function public.build_job_price_quote_v2(
  input_sku text,
  input_price_version integer,
  input_default_reserve_tokens bigint,
  input_raw_token_cap bigint,
  input_token_multiplier_millis integer,
  input_catalog_reserve_cost_micros bigint,
  input_currency text,
  input_funding text,
  input_billing_class text,
  input_authorized_tokens bigint,
  input_authorized_cost_micros bigint
)
returns jsonb
language sql
immutable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'schemaVersion', 2,
    'hashAlgorithm', 'sha256-jsonb-text-pg16',
    'sku', input_sku,
    'priceVersion', input_price_version,
    'defaultReserveTokens', input_default_reserve_tokens,
    'rawTokenCap', input_raw_token_cap,
    'tokenMultiplierMillis', input_token_multiplier_millis,
    'catalogReserveCostMicros', input_catalog_reserve_cost_micros,
    'currency', input_currency,
    'funding', input_funding,
    'billingClass', input_billing_class,
    'authorizedTokens', input_authorized_tokens,
    'authorizedCostMicros', input_authorized_cost_micros
  );
$$;

revoke all on function public.job_price_quote_hash(jsonb),
  public.build_job_price_quote_v2(text,integer,bigint,bigint,integer,bigint,text,text,text,bigint,bigint)
  from public, anon, authenticated, service_role;

alter table public.job_admission_reservations
  add column if not exists price_quote jsonb,
  add column if not exists price_quote_hash text;

with reservation_quotes as (
  select
    reservation.job_id,
    public.build_job_price_quote_v2(
      reservation.sku,
      reservation.price_version,
      catalog.default_reserve_tokens,
      catalog.raw_token_cap,
      catalog.token_multiplier_millis,
      catalog.reserve_cost_micros,
      catalog.currency,
      reservation.funding,
      case when reservation.funding = 'customer' then 'customer' else 'platform' end,
      reservation.reserved_tokens,
      reservation.reserved_cost_micros
    ) as value
  from public.job_admission_reservations as reservation
  join public.job_price_catalog as catalog
    on catalog.sku = reservation.sku
   and catalog.version = reservation.price_version
  where reservation.price_quote is null or reservation.price_quote_hash is null
)
update public.job_admission_reservations as reservation
set price_quote = quote.value,
    price_quote_hash = public.job_price_quote_hash(quote.value)
from reservation_quotes as quote
where reservation.job_id = quote.job_id;

alter table public.job_admission_reservations
  alter column price_quote set not null,
  alter column price_quote_hash set not null,
  drop constraint if exists job_admission_reservations_quote_shape_check,
  add constraint job_admission_reservations_quote_shape_check check (
    jsonb_typeof(price_quote) = 'object'
    and price_quote ?& array[
      'schemaVersion', 'hashAlgorithm', 'sku', 'priceVersion',
      'defaultReserveTokens', 'rawTokenCap', 'tokenMultiplierMillis',
      'catalogReserveCostMicros', 'currency', 'funding', 'billingClass',
      'authorizedTokens', 'authorizedCostMicros'
    ]::text[]
    and jsonb_typeof(price_quote->'schemaVersion') = 'number'
    and jsonb_typeof(price_quote->'hashAlgorithm') = 'string'
    and jsonb_typeof(price_quote->'sku') = 'string'
    and jsonb_typeof(price_quote->'priceVersion') = 'number'
    and jsonb_typeof(price_quote->'defaultReserveTokens') = 'number'
    and jsonb_typeof(price_quote->'tokenMultiplierMillis') = 'number'
    and jsonb_typeof(price_quote->'catalogReserveCostMicros') = 'number'
    and jsonb_typeof(price_quote->'currency') = 'string'
    and jsonb_typeof(price_quote->'funding') = 'string'
    and jsonb_typeof(price_quote->'billingClass') = 'string'
    and jsonb_typeof(price_quote->'authorizedTokens') = 'number'
    and jsonb_typeof(price_quote->'authorizedCostMicros') = 'number'
    and price_quote->>'schemaVersion' is not distinct from '2'
    and price_quote->>'hashAlgorithm' is not distinct from 'sha256-jsonb-text-pg16'
    and price_quote->>'sku' is not distinct from sku
    and price_quote->>'priceVersion' is not distinct from price_version::text
    and price_quote->>'funding' is not distinct from funding
    and price_quote->>'billingClass' is not distinct from
      case when funding = 'customer' then 'customer' else 'platform' end
    and price_quote->>'authorizedTokens' is not distinct from reserved_tokens::text
    and price_quote->>'authorizedCostMicros' is not distinct from reserved_cost_micros::text
    and price_quote_hash ~ '^[0-9a-f]{64}$'
    and price_quote_hash = public.job_price_quote_hash(price_quote)
  ) not valid;
alter table public.job_admission_reservations
  validate constraint job_admission_reservations_quote_shape_check;

create or replace function public.enforce_job_admission_quote_immutable()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.job_id is distinct from old.job_id
     or new.principal_id is distinct from old.principal_id
     or new.sku is distinct from old.sku
     or new.price_version is distinct from old.price_version
     or new.funding is distinct from old.funding
     or new.reserved_tokens is distinct from old.reserved_tokens
     or new.reserved_cost_micros is distinct from old.reserved_cost_micros
     or new.created_at is distinct from old.created_at
     or new.price_quote is distinct from old.price_quote
     or new.price_quote_hash is distinct from old.price_quote_hash then
    raise exception 'job_admission_quote_is_immutable' using errcode = '55000';
  end if;
  return new;
end;
$$;
drop trigger if exists job_admission_quote_immutable
  on public.job_admission_reservations;
create trigger job_admission_quote_immutable
before update on public.job_admission_reservations
for each row execute function public.enforce_job_admission_quote_immutable();
revoke all on function public.enforce_job_admission_quote_immutable()
  from public, anon, authenticated, service_role;

-- Every profile balance is anchored once. All later balance changes are
-- journaled by a trigger, including invitation top-ups and future admin paths.
create table if not exists public.profile_balance_anchors (
  principal_id uuid primary key references auth.users(id) on delete restrict,
  balance bigint not null check (balance >= 0),
  anchored_at timestamptz not null default now()
);
create table if not exists public.profile_balance_journal (
  sequence bigint generated always as identity primary key,
  principal_id uuid not null references auth.users(id) on delete restrict,
  delta_tokens bigint not null check (delta_tokens <> 0),
  balance_before bigint not null check (balance_before >= 0),
  balance_after bigint not null check (balance_after >= 0),
  source text not null check (length(source) between 1 and 200),
  transaction_id bigint not null default txid_current(),
  created_at timestamptz not null default now(),
  constraint profile_balance_journal_delta_check
    check (balance_after - balance_before = delta_tokens)
);
create index if not exists profile_balance_journal_principal_sequence_idx
  on public.profile_balance_journal(principal_id, sequence);

alter table public.profile_balance_anchors enable row level security;
alter table public.profile_balance_journal enable row level security;
revoke all on table public.profile_balance_anchors, public.profile_balance_journal
  from public, anon, authenticated, service_role;
grant select on table public.profile_balance_anchors, public.profile_balance_journal
  to service_role;

create or replace function public.track_profile_balance_journal()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  before_balance bigint := case when tg_op = 'INSERT' then 0 else coalesce(old.balance, 0)::bigint end;
  after_balance bigint := coalesce(new.balance, 0)::bigint;
  source_name text := coalesce(
    nullif(current_setting('mychat.balance_source', true), ''),
    case when tg_op = 'INSERT' then 'profile.insert' else 'profile.update' end
  );
begin
  if after_balance < 0 then
    raise exception 'profile_balance_cannot_be_negative' using errcode = '23514';
  end if;
  if after_balance <> before_balance then
    insert into public.profile_balance_journal(
      principal_id, delta_tokens, balance_before, balance_after, source, created_at
    ) values (
      new.user_id, after_balance - before_balance, before_balance, after_balance,
      left(source_name, 200), clock_timestamp()
    );
  end if;
  return new;
end;
$$;

drop trigger if exists track_profile_balance_journal on public.profiles;
create trigger track_profile_balance_journal
after insert or update of balance on public.profiles
for each row execute function public.track_profile_balance_journal();

-- CREATE TRIGGER retains a write-conflicting lock until commit. Anchoring after
-- it closes the scan-before-trigger cutover gap for concurrent balance writes.
with journal_totals as (
  select principal_id, sum(delta_tokens)::bigint as delta_tokens
  from public.profile_balance_journal
  group by principal_id
)
insert into public.profile_balance_anchors(principal_id, balance, anchored_at)
select profile.user_id,
  greatest(coalesce(profile.balance, 0), 0)::bigint
    - coalesce(journal.delta_tokens, 0),
  clock_timestamp()
from public.profiles as profile
left join journal_totals as journal on journal.principal_id = profile.user_id
on conflict (principal_id) do nothing;

create or replace function public.reject_billing_append_only_mutation()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception '% is append_only', tg_table_name using errcode = '55000';
end;
$$;
drop trigger if exists profile_balance_anchors_append_only on public.profile_balance_anchors;
create trigger profile_balance_anchors_append_only
before update or delete on public.profile_balance_anchors
for each row execute function public.reject_billing_append_only_mutation();
drop trigger if exists profile_balance_journal_append_only on public.profile_balance_journal;
create trigger profile_balance_journal_append_only
before update or delete on public.profile_balance_journal
for each row execute function public.reject_billing_append_only_mutation();

revoke all on function public.track_profile_balance_journal(),
  public.reject_billing_append_only_mutation()
  from public, anon, authenticated, service_role;

-- Allocation receipts prove: hold = gross debit - credit reversal + release.
-- Only hold/release mutate profiles; debit/credit allocate the held amount.
create table if not exists public.job_balance_movements (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null,
  principal_id uuid not null,
  ledger_entry_id uuid,
  kind text not null check (kind in ('hold', 'debit', 'credit', 'release')),
  tokens bigint not null check (tokens >= 0),
  created_at timestamptz not null default now(),
  constraint job_balance_movements_job_fkey
    foreign key (principal_id, job_id)
    references public.jobs(principal_id, id)
    on delete restrict deferrable initially deferred,
  constraint job_balance_movements_ledger_fkey
    foreign key (principal_id, ledger_entry_id)
    references public.ledger_entries(principal_id, id)
    on delete restrict deferrable initially deferred,
  constraint job_balance_movements_shape_check check (
    (kind in ('hold', 'release') and ledger_entry_id is null)
    or (kind in ('debit', 'credit') and ledger_entry_id is not null)
  )
);
create unique index if not exists job_balance_movements_boundary_uidx
  on public.job_balance_movements(job_id, kind)
  where kind in ('hold', 'release');
create unique index if not exists job_balance_movements_ledger_uidx
  on public.job_balance_movements(ledger_entry_id)
  where ledger_entry_id is not null;
create index if not exists job_balance_movements_job_kind_idx
  on public.job_balance_movements(job_id, kind);
create index if not exists job_balance_movements_principal_created_idx
  on public.job_balance_movements(principal_id, created_at desc);

alter table public.job_balance_movements enable row level security;
revoke all on table public.job_balance_movements
  from public, anon, authenticated, service_role;
grant select on table public.job_balance_movements to service_role;

insert into public.job_balance_movements(
  job_id, principal_id, kind, tokens, created_at
)
select job_id, principal_id, 'hold', reserved_tokens, created_at
from public.job_admission_reservations
where funding = 'balance'
on conflict do nothing;

insert into public.job_balance_movements(
  job_id, principal_id, ledger_entry_id, kind, tokens, created_at
)
select entry.job_id, entry.principal_id, entry.id, entry.direction,
  entry.weighted_tokens, entry.created_at
from public.ledger_entries as entry
join public.job_admission_reservations as reservation
  on reservation.job_id = entry.job_id
 and reservation.principal_id = entry.principal_id
where reservation.funding = 'balance'
  and entry.direction in ('debit', 'credit')
on conflict do nothing;

insert into public.job_balance_movements(
  job_id, principal_id, kind, tokens, created_at
)
select job_id, principal_id, 'release', released_tokens, settled_at
from public.job_admission_reservations
where funding = 'balance' and status in ('settled', 'released')
on conflict do nothing;

drop trigger if exists job_balance_movements_append_only on public.job_balance_movements;
create trigger job_balance_movements_append_only
before update or delete on public.job_balance_movements
for each row execute function public.reject_billing_append_only_mutation();

-- A durable version marker is the only compatibility escape hatch. Rows that
-- predate atomic reservations are v1; every post-cutover insert is forced to v2.
alter table public.jobs
  add column if not exists billing_contract_version smallint;
-- ALTER TABLE retains ACCESS EXCLUSIVE through this transaction, so no writer
-- can cross the compatibility backfill while the legacy whole-row immutability
-- trigger is suspended. This is required for already-terminal historical Jobs.
alter table public.jobs disable trigger enforce_job_state_contract;
update public.jobs as job
set billing_contract_version = case when exists (
  select 1 from public.job_admission_reservations as reservation
  where reservation.job_id = job.id and reservation.principal_id = job.principal_id
) then 2 else 1 end
where billing_contract_version is null;
alter table public.jobs enable trigger enforce_job_state_contract;
alter table public.jobs
  alter column billing_contract_version set default 2,
  alter column billing_contract_version set not null,
  drop constraint if exists jobs_billing_contract_version_check,
  add constraint jobs_billing_contract_version_check
    check (billing_contract_version in (1, 2)) not valid;
alter table public.jobs validate constraint jobs_billing_contract_version_check;
create index if not exists jobs_billing_contract_status_idx
  on public.jobs(billing_contract_version, status, id);
create index if not exists job_admission_reservations_status_job_idx
  on public.job_admission_reservations(status, job_id);

create table if not exists public.job_billing_cutovers (
  contract_version smallint primary key check (contract_version = 2),
  cutover_at timestamptz not null,
  legacy_nonterminal_jobs_at_cutover bigint not null check (legacy_nonterminal_jobs_at_cutover >= 0),
  created_at timestamptz not null default now()
);
alter table public.job_billing_cutovers enable row level security;
revoke all on table public.job_billing_cutovers
  from public, anon, authenticated, service_role;
grant select on table public.job_billing_cutovers to service_role;
insert into public.job_billing_cutovers(
  contract_version, cutover_at, legacy_nonterminal_jobs_at_cutover
)
select 2, clock_timestamp(), count(*)
from public.jobs
where billing_contract_version = 1
  and status not in ('completed', 'failed', 'cancelled')
on conflict (contract_version) do nothing;
drop trigger if exists job_billing_cutovers_append_only on public.job_billing_cutovers;
create trigger job_billing_cutovers_append_only
before update or delete on public.job_billing_cutovers
for each row execute function public.reject_billing_append_only_mutation();

-- The snapshot is a constant-time production gate. A worker refreshes it on a
-- bounded cadence; the expensive scan has a hard statement timeout and never
-- runs in /api/ready.
create table if not exists public.billing_reconciliation_snapshots (
  singleton boolean primary key default true check (singleton),
  generation bigint not null default 0 check (generation >= 0),
  generated_at timestamptz not null,
  healthy boolean not null,
  metrics jsonb not null check (jsonb_typeof(metrics) = 'object'),
  updated_at timestamptz not null default now()
);
alter table public.billing_reconciliation_snapshots enable row level security;
revoke all on table public.billing_reconciliation_snapshots
  from public, anon, authenticated, service_role;

create or replace function public.compute_billing_reconciliation_v1()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
set statement_timeout = '3s'
as $$
declare
  v_now timestamptz := clock_timestamp();
  new_jobs_without_reservations bigint;
  active_legacy_jobs bigint;
  terminal_held_reservations bigint;
  quote_mismatches bigint;
  movement_equation_mismatches bigint;
  ledger_receipt_mismatches bigint;
  profile_balance_mismatches bigint;
  catalog_activation_mismatches bigint;
  total_mismatches bigint;
  release_blockers bigint;
  held_balance_tokens bigint;
begin
  select count(*) into new_jobs_without_reservations
  from public.jobs as job
  where job.billing_contract_version = 2
    and not exists (
      select 1 from public.job_admission_reservations as reservation
      where reservation.job_id = job.id
        and reservation.principal_id = job.principal_id
    );

  select count(*) into active_legacy_jobs
  from public.jobs
  where billing_contract_version = 1
    and status not in ('completed', 'failed', 'cancelled');

  select count(*) into terminal_held_reservations
  from public.job_admission_reservations as reservation
  join public.jobs as job
    on job.id = reservation.job_id and job.principal_id = reservation.principal_id
  where reservation.status = 'held'
    and job.status in ('completed', 'failed', 'cancelled');

  select count(*) into quote_mismatches
  from public.job_admission_reservations as reservation
  join public.job_price_catalog as catalog
    on catalog.sku = reservation.sku
   and catalog.version = reservation.price_version
  where reservation.price_quote_hash is distinct from
      public.job_price_quote_hash(reservation.price_quote)
     or reservation.price_quote is distinct from public.build_job_price_quote_v2(
       reservation.sku,
       reservation.price_version,
       catalog.default_reserve_tokens,
       catalog.raw_token_cap,
       catalog.token_multiplier_millis,
       catalog.reserve_cost_micros,
       catalog.currency,
       reservation.funding,
       case when reservation.funding = 'customer' then 'customer' else 'platform' end,
       reservation.reserved_tokens,
       reservation.reserved_cost_micros
     );

  with movement_totals as (
    select reservation.job_id,
      reservation.principal_id,
      reservation.status,
      reservation.reserved_tokens,
      reservation.actual_tokens,
      reservation.released_tokens,
      coalesce(sum(movement.tokens) filter (where movement.kind = 'hold'), 0)::bigint as held,
      coalesce(sum(movement.tokens) filter (where movement.kind = 'debit'), 0)::bigint as debited,
      coalesce(sum(movement.tokens) filter (where movement.kind = 'credit'), 0)::bigint as credited,
      coalesce(sum(movement.tokens) filter (where movement.kind = 'release'), 0)::bigint as released
    from public.job_admission_reservations as reservation
    left join public.job_balance_movements as movement
      on movement.job_id = reservation.job_id
     and movement.principal_id = reservation.principal_id
    where reservation.funding = 'balance'
    group by reservation.job_id, reservation.principal_id, reservation.status,
      reservation.reserved_tokens, reservation.actual_tokens,
      reservation.released_tokens
  )
  select count(*) into movement_equation_mismatches
  from movement_totals
  where credited > debited
     or held <> reserved_tokens
     or debited - credited > reserved_tokens
     or (
       status = 'held'
       and (actual_tokens <> 0 or released_tokens <> 0 or released <> 0)
     )
     or (
       status in ('settled', 'released')
       and (
         debited - credited <> actual_tokens
         or released <> released_tokens
         or held <> debited - credited + released
       )
     );

  select count(*) into ledger_receipt_mismatches
  from public.ledger_entries as entry
  join public.job_admission_reservations as reservation
    on reservation.job_id = entry.job_id
   and reservation.principal_id = entry.principal_id
  left join public.job_balance_movements as movement
    on movement.ledger_entry_id = entry.id
   and movement.principal_id = entry.principal_id
  left join public.ledger_balance_settlements as settlement
    on settlement.ledger_entry_id = entry.id
   and settlement.principal_id = entry.principal_id
  where reservation.funding = 'balance'
    and (
      movement.id is null
      or movement.kind <> entry.direction
      or movement.tokens <> entry.weighted_tokens
      or (entry.direction = 'debit' and (
        settlement.ledger_entry_id is null
        or settlement.requested_tokens <> entry.weighted_tokens
        or settlement.debited_tokens <> case
          when reservation.status = 'held' then 0 else entry.weighted_tokens end
      ))
      or (entry.direction = 'credit' and settlement.ledger_entry_id is not null)
    );

  with balance_principals as (
    select user_id as principal_id from public.profiles
    union
    select principal_id from public.profile_balance_anchors
    union
    select principal_id from public.profile_balance_journal
  ), journal_totals as (
    select principal_id, sum(delta_tokens)::bigint as delta
    from public.profile_balance_journal
    group by principal_id
  )
  select count(*) into profile_balance_mismatches
  from balance_principals as principal
  left join public.profiles as profile
    on profile.user_id = principal.principal_id
  left join public.profile_balance_anchors as anchor
    on anchor.principal_id = principal.principal_id
  left join journal_totals as changes
    on changes.principal_id = principal.principal_id
  where profile.user_id is null
     or coalesce(profile.balance, 0)::bigint
       <> coalesce(anchor.balance, 0) + coalesce(changes.delta, 0);

  select count(*) into catalog_activation_mismatches
  from (
    select sku from public.job_price_catalog
    union
    select sku from public.job_price_activations
    union
    select sku from public.job_price_activation_heads
  ) as observed_sku
  left join public.job_price_activation_heads as head
    on head.sku = observed_sku.sku
  where head.sku is null
     or not exists (
       select 1
       from public.job_price_activations as activation
       where activation.sku = head.sku
         and activation.price_version = head.price_version
         and activation.activation_generation = head.activation_generation
     )
     or head.activation_generation is distinct from (
       select max(activation.activation_generation)
       from public.job_price_activations as activation
       where activation.sku = observed_sku.sku
     )
     or exists (
       select 1
       from public.job_price_activations as later
       join public.job_price_activations as earlier
         on earlier.sku = later.sku
        and earlier.activation_generation = later.activation_generation - 1
       where later.sku = observed_sku.sku
         and later.price_version <= earlier.price_version
     );

  select coalesce(sum(reserved_tokens), 0)::bigint into held_balance_tokens
  from public.job_admission_reservations
  where funding = 'balance' and status = 'held';

  total_mismatches := new_jobs_without_reservations
    + terminal_held_reservations
    + quote_mismatches
    + movement_equation_mismatches
    + ledger_receipt_mismatches
    + profile_balance_mismatches
    + catalog_activation_mismatches;
  release_blockers := total_mismatches + active_legacy_jobs;

  return jsonb_build_object(
    'schemaVersion', 1,
    'generatedAt', v_now,
    'healthy', total_mismatches = 0,
    'releaseReady', release_blockers = 0,
    'releaseBlockers', release_blockers,
    'totalMismatches', total_mismatches,
    'newJobsWithoutReservations', new_jobs_without_reservations,
    'activeLegacyJobs', active_legacy_jobs,
    'terminalHeldReservations', terminal_held_reservations,
    'quoteMismatches', quote_mismatches,
    'movementEquationMismatches', movement_equation_mismatches,
    'ledgerReceiptMismatches', ledger_receipt_mismatches,
    'profileBalanceMismatches', profile_balance_mismatches,
    'catalogActivationMismatches', catalog_activation_mismatches,
    'heldBalanceTokens', held_balance_tokens
  );
end;
$$;

create or replace function public.refresh_billing_reconciliation_v1()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
set lock_timeout = '1s'
set statement_timeout = '5s'
as $$
declare
  snapshot jsonb;
begin
  if not pg_try_advisory_xact_lock(5720260713290000) then
    raise exception 'billing_reconciliation_refresh_busy' using errcode = '55P03';
  end if;
  snapshot := public.compute_billing_reconciliation_v1();
  insert into public.billing_reconciliation_snapshots(
    singleton, generation, generated_at, healthy, metrics, updated_at
  ) values (
    true, 1, (snapshot->>'generatedAt')::timestamptz,
    (snapshot->>'healthy')::boolean, snapshot, clock_timestamp()
  )
  on conflict (singleton) do update set
    generation = public.billing_reconciliation_snapshots.generation + 1,
    generated_at = excluded.generated_at,
    healthy = excluded.healthy,
    metrics = excluded.metrics,
    updated_at = excluded.updated_at;
  return snapshot;
end;
$$;

create or replace function public.read_billing_reconciliation_v1()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
set statement_timeout = '1s'
as $$
  select metrics || jsonb_build_object(
    'generation', generation,
    'generatedAt', generated_at,
    'healthy', healthy
  )
  from public.billing_reconciliation_snapshots
  where singleton;
$$;

revoke all on function public.compute_billing_reconciliation_v1(),
  public.refresh_billing_reconciliation_v1(),
  public.read_billing_reconciliation_v1()
  from public, anon, authenticated, service_role;
grant execute on function public.refresh_billing_reconciliation_v1(),
  public.read_billing_reconciliation_v1()
  to service_role;

-- The new admission function reads only the latest append-only activation and
-- commits the complete quote, hold, Job and version marker atomically.
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
  v_quote jsonb;
  v_quote_hash text;
  v_reconciliation_ready boolean := false;
begin
  new.billing_contract_version := 2;
  v_sku := case
    when new.type = 'chat.generation' and new.payload->>'outputKind' = 'image' then 'media.image'
    when new.type = 'chat.generation' and new.payload->>'outputKind' = 'video' then 'media.video'
    when new.type = 'chat.generation' then 'chat.text'
    when new.type = 'chat.title' then 'chat.title'
    when new.type = 'agent.task' then 'agent.task'
    when new.type = 'agent.operation' then 'agent.operation'
    else 'internal.default'
  end;

  select catalog.* into strict v_price
  from public.job_price_activation_heads as head
  join public.job_price_activations as activation
    on activation.sku = head.sku
   and activation.price_version = head.price_version
   and activation.activation_generation = head.activation_generation
  join public.job_price_catalog as catalog
    on catalog.sku = head.sku and catalog.version = head.price_version
  where head.sku = v_sku
  for key share of catalog;

  select snapshot.healthy
    and snapshot.generated_at >= v_now - interval '10 minutes'
  into v_reconciliation_ready
  from public.billing_reconciliation_snapshots as snapshot
  where snapshot.singleton;
  if not coalesce(v_reconciliation_ready, false) then
    raise exception 'billing_reconciliation_unhealthy'
      using errcode = '55000',
            detail = 'New paid work is disabled until the authoritative balance snapshot reconciles.';
  end if;

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
      perform set_config('mychat.balance_source', 'job.admission.hold', true);
      update public.profiles set
        balance = v_balance - v_reserve_tokens,
        quota_version = coalesce(quota_version, 0) + 1
      where user_id = new.principal_id;
    end if;
  end if;

  if coalesce(new.budget->>'wallTimeMs', '') ~ '^[0-9]{1,13}$' then
    v_wall_time_ms := least((new.budget->>'wallTimeMs')::bigint, 86400000);
  end if;
  v_quote := public.build_job_price_quote_v2(
    v_sku, v_price.version, v_price.default_reserve_tokens,
    v_price.raw_token_cap, v_price.token_multiplier_millis,
    v_price.reserve_cost_micros, v_price.currency, v_funding,
    v_billing_class, v_reserve_tokens, v_reserve_cost_micros
  );
  v_quote_hash := public.job_price_quote_hash(v_quote);

  insert into public.job_admission_reservations(
    job_id, principal_id, sku, price_version, funding, status,
    reserved_tokens, reserved_cost_micros, price_quote, price_quote_hash,
    created_at, expires_at
  ) values (
    new.id, new.principal_id, v_sku, v_price.version, v_funding, 'held',
    v_reserve_tokens, v_reserve_cost_micros, v_quote, v_quote_hash, v_now,
    v_now + make_interval(secs => ((v_wall_time_ms + 3600000) / 1000)::double precision)
  );
  if v_funding = 'balance' then
    insert into public.job_balance_movements(
      job_id, principal_id, kind, tokens, created_at
    ) values (new.id, new.principal_id, 'hold', v_reserve_tokens, v_now);
  end if;

  new.payload := new.payload || jsonb_build_object('admission', jsonb_build_object(
    'schemaVersion', 2,
    'billingContractVersion', 2,
    'funding', v_funding,
    'sku', v_sku,
    'priceVersion', v_price.version,
    'reservedTokens', v_reserve_tokens,
    'reservedCostMicros', v_reserve_cost_micros,
    'quoteHash', v_quote_hash
  ));
  return new;
end;
$$;

create or replace function public.enforce_job_billing_contract()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    if new.billing_contract_version <> 2 then
      raise exception 'new_job_requires_billing_contract_v2' using errcode = '23514';
    end if;
    if new.status in ('completed', 'failed', 'cancelled') then
      raise exception 'new_job_cannot_start_terminal' using errcode = '23514';
    end if;
    return new;
  end if;
  if new.billing_contract_version is distinct from old.billing_contract_version then
    raise exception 'job_billing_contract_is_immutable' using errcode = '55000';
  end if;
  if new.billing_contract_version = 2
     and new.status in ('completed', 'failed', 'cancelled')
     and old.status not in ('completed', 'failed', 'cancelled')
     and not exists (
       select 1 from public.job_admission_reservations as reservation
       where reservation.job_id = new.id
         and reservation.principal_id = new.principal_id
     ) then
    raise exception 'job_reservation_required_for_terminal' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists jobs_reserve_admission on public.jobs;
create trigger jobs_reserve_admission
before insert on public.jobs
for each row execute function public.reserve_job_admission();
drop trigger if exists jobs_billing_contract_guard on public.jobs;
create trigger jobs_billing_contract_guard
before insert or update of status, billing_contract_version on public.jobs
for each row execute function public.enforce_job_billing_contract();

revoke all on function public.reserve_job_admission(),
  public.enforce_job_billing_contract()
  from public, anon, authenticated, service_role;

create or replace function public.settle_job_admission(
  input_job_id uuid,
  input_reason text default 'terminal'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reservation public.job_admission_reservations%rowtype;
  v_job public.jobs%rowtype;
  v_debit_tokens bigint := 0;
  v_credit_tokens bigint := 0;
  v_debit_cost_micros bigint := 0;
  v_credit_cost_micros bigint := 0;
  v_actual_tokens bigint := 0;
  v_actual_cost_micros bigint := 0;
  v_release bigint := 0;
  v_balance bigint := 0;
  v_status text;
  v_now timestamptz := clock_timestamp();
  movement_held bigint := 0;
  movement_debited bigint := 0;
  movement_credited bigint := 0;
  movement_released bigint := 0;
begin
  -- Every path that can settle already owns, or first acquires, the Job lock.
  -- Keeping this global order prevents a direct settlement from holding the
  -- reservation while a terminal Job transaction waits for it at commit.
  select * into v_job from public.jobs
  where id = input_job_id for update;
  if not found then
    return jsonb_build_object('settled', false, 'replayed', false, 'reason', 'not_reserved');
  end if;
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
  if v_job.status not in ('completed', 'failed', 'cancelled') then
    return jsonb_build_object('settled', false, 'replayed', false, 'reason', 'job_not_terminal');
  end if;

  select
    coalesce(sum(weighted_tokens) filter (where direction = 'debit'), 0)::bigint,
    coalesce(sum(weighted_tokens) filter (where direction = 'credit'), 0)::bigint,
    coalesce(sum(round(cost_estimate * 1000000)) filter (where direction = 'debit'), 0)::bigint,
    coalesce(sum(round(cost_estimate * 1000000)) filter (where direction = 'credit'), 0)::bigint
  into v_debit_tokens, v_credit_tokens, v_debit_cost_micros, v_credit_cost_micros
  from public.ledger_entries
  where job_id = input_job_id and principal_id = v_reservation.principal_id;

  if v_credit_tokens > v_debit_tokens or v_credit_cost_micros > v_debit_cost_micros then
    raise exception 'job_admission_credit_over_reversal'
      using errcode = '23514',
            detail = 'A Job credit cannot exceed the debit it reverses.';
  end if;
  v_actual_tokens := v_debit_tokens - v_credit_tokens;
  v_actual_cost_micros := v_debit_cost_micros - v_credit_cost_micros;
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
    perform set_config('mychat.balance_source', 'job.admission.release', true);
    update public.profiles set
      balance = v_balance + v_release,
      quota_version = coalesce(quota_version, 0) + 1
    where user_id = v_reservation.principal_id
    returning balance::bigint into v_balance;

    insert into public.job_balance_movements(
      job_id, principal_id, kind, tokens, created_at
    ) values (
      input_job_id, v_reservation.principal_id, 'release', v_release, v_now
    );
    update public.ledger_balance_settlements as settlement set
      debited_tokens = settlement.requested_tokens,
      remaining_balance = v_balance
    from public.ledger_entries as entry
    where settlement.ledger_entry_id = entry.id
      and settlement.principal_id = entry.principal_id
      and entry.job_id = input_job_id
      and entry.direction = 'debit';

    select
      coalesce(sum(tokens) filter (where kind = 'hold'), 0)::bigint,
      coalesce(sum(tokens) filter (where kind = 'debit'), 0)::bigint,
      coalesce(sum(tokens) filter (where kind = 'credit'), 0)::bigint,
      coalesce(sum(tokens) filter (where kind = 'release'), 0)::bigint
    into movement_held, movement_debited, movement_credited, movement_released
    from public.job_balance_movements
    where job_id = input_job_id and principal_id = v_reservation.principal_id;
    if movement_held <> v_reservation.reserved_tokens
       or movement_debited <> v_debit_tokens
       or movement_credited <> v_credit_tokens
       or movement_released <> v_release
       or movement_held <> movement_debited - movement_credited + movement_released then
      raise exception 'job_balance_movement_invariant_failed' using errcode = '23514';
    end if;
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
    'releasedTokens', v_release,
    'grossDebitTokens', v_debit_tokens,
    'creditTokens', v_credit_tokens
  );
end;
$$;

-- Terminal projection and final ledger insertion share one transaction. The
-- reservation must settle at commit, after every ledger trigger has emitted
-- its immutable movement receipt, rather than at the first terminal UPDATE.
drop trigger if exists jobs_settle_admission on public.jobs;
create constraint trigger jobs_settle_admission
after insert or update on public.jobs
deferrable initially deferred
for each row execute function public.settle_job_admission_on_terminal();

create or replace function public.settle_ledger_balance_debit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reservation public.job_admission_reservations%rowtype;
  v_job_contract smallint;
  v_balance bigint := 0;
  v_debit bigint := 0;
begin
  select * into v_reservation
  from public.job_admission_reservations
  where job_id = new.job_id;
  if found then
    if v_reservation.principal_id is distinct from new.principal_id then
      raise exception 'job_admission_principal_mismatch' using errcode = '23514';
    end if;
    if v_reservation.funding = 'balance' then
      insert into public.job_balance_movements(
        job_id, principal_id, ledger_entry_id, kind, tokens, created_at
      ) values (
        new.job_id, new.principal_id, new.id, new.direction,
        new.weighted_tokens, clock_timestamp()
      );
      if new.direction = 'debit' then
        select greatest(coalesce(balance, 0), 0)::bigint into v_balance
        from public.profiles where user_id = new.principal_id;
        insert into public.ledger_balance_settlements(
          ledger_entry_id, principal_id, requested_tokens,
          debited_tokens, remaining_balance, created_at
        ) values (
          new.id, new.principal_id, new.weighted_tokens, 0, v_balance, clock_timestamp()
        );
      end if;
    end if;
    return new;
  end if;

  select billing_contract_version into v_job_contract
  from public.jobs where id = new.job_id;
  if coalesce(v_job_contract, 2) >= 2 then
    raise exception 'job_reservation_required_for_ledger' using errcode = '23514';
  end if;
  if new.weighted_tokens <= 0
     or new.direction <> 'debit'
     or coalesce(new.metadata->>'usingBalance', 'false') <> 'true' then
    return new;
  end if;

  insert into public.profiles(user_id, balance)
  values (new.principal_id, 0) on conflict (user_id) do nothing;
  select greatest(coalesce(balance, 0), 0)::bigint into v_balance
  from public.profiles where user_id = new.principal_id for update;
  v_debit := least(v_balance, new.weighted_tokens);
  perform set_config('mychat.balance_source', 'legacy.job.debit', true);
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

revoke all on function public.settle_job_admission(uuid,text),
  public.settle_ledger_balance_debit()
  from public, anon, authenticated, service_role;
grant execute on function public.settle_job_admission(uuid,text) to service_role;

-- The browser-era post-paid RPC is incompatible with reservation accounting
-- and the immutable balance journal. Durable Jobs are now the only usage path.
do $$
begin
  if to_regprocedure('public.record_quota_usage(bigint,boolean)') is not null then
    execute 'revoke all on function public.record_quota_usage(bigint,boolean) '
      || 'from public, anon, authenticated, service_role';
  end if;
end;
$$;

create or replace function public.runtime_healthcheck_v13()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
set statement_timeout = '1s'
as $$
  select public.runtime_healthcheck_v12()
    and to_regclass('public.job_price_activations') is not null
    and to_regclass('public.job_price_activation_heads') is not null
    and to_regclass('public.job_balance_movements') is not null
    and to_regclass('public.profile_balance_anchors') is not null
    and to_regclass('public.profile_balance_journal') is not null
    and to_regclass('public.billing_reconciliation_snapshots') is not null
    and to_regprocedure('public.refresh_billing_reconciliation_v1()') is not null
    and to_regprocedure('public.read_billing_reconciliation_v1()') is not null
    and has_function_privilege(
      'service_role', 'public.read_billing_reconciliation_v1()', 'EXECUTE'
    )
    and has_function_privilege(
      'service_role', 'public.refresh_billing_reconciliation_v1()', 'EXECUTE'
    )
    and has_function_privilege(
      'service_role', 'public.settle_job_admission(uuid,text)', 'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated', 'public.read_billing_reconciliation_v1()', 'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated', 'public.refresh_billing_reconciliation_v1()', 'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated', 'public.settle_job_admission(uuid,text)', 'EXECUTE'
    )
    and not has_function_privilege(
      'anon', 'public.read_billing_reconciliation_v1()', 'EXECUTE'
    )
    and not has_function_privilege(
      'anon', 'public.refresh_billing_reconciliation_v1()', 'EXECUTE'
    )
    and coalesce(not has_function_privilege(
      'authenticated',
      to_regprocedure('public.record_quota_usage(bigint,boolean)'),
      'EXECUTE'
    ), true)
    and not exists (
      select 1
      from (values
        ('job_price_activations'),
        ('job_price_activation_heads'),
        ('job_balance_movements'),
        ('profile_balance_anchors'),
        ('profile_balance_journal'),
        ('billing_reconciliation_snapshots')
      ) as protected_table(table_name)
      join pg_class as relation
        on relation.oid = to_regclass('public.' || protected_table.table_name)
      where not relation.relrowsecurity
         or has_table_privilege('authenticated', relation.oid, 'SELECT')
         or has_table_privilege('authenticated', relation.oid, 'INSERT')
         or has_table_privilege('authenticated', relation.oid, 'UPDATE')
         or has_table_privilege('authenticated', relation.oid, 'DELETE')
         or has_table_privilege('anon', relation.oid, 'SELECT')
         or has_table_privilege('anon', relation.oid, 'INSERT')
         or has_table_privilege('anon', relation.oid, 'UPDATE')
         or has_table_privilege('anon', relation.oid, 'DELETE')
         or has_table_privilege('service_role', relation.oid, 'INSERT')
         or has_table_privilege('service_role', relation.oid, 'UPDATE')
         or has_table_privilege('service_role', relation.oid, 'DELETE')
    )
    and exists (
      select 1
      from pg_constraint as quote_constraint
      where quote_constraint.conrelid = 'public.job_admission_reservations'::regclass
        and quote_constraint.conname = 'job_admission_reservations_quote_shape_check'
        and quote_constraint.contype = 'c'
        and quote_constraint.convalidated
    )
    and not exists (
      select 1
      from (values
        ('job_price_catalog'::text, 'job_price_catalog_append_only'::text,
          'public.enforce_job_price_catalog_append_only()'::text),
        ('job_price_activations', 'job_price_activations_append_only',
          'public.enforce_job_price_activation_append_only()'),
        ('job_admission_reservations', 'job_admission_quote_immutable',
          'public.enforce_job_admission_quote_immutable()'),
        ('profiles', 'track_profile_balance_journal',
          'public.track_profile_balance_journal()'),
        ('profile_balance_anchors', 'profile_balance_anchors_append_only',
          'public.reject_billing_append_only_mutation()'),
        ('profile_balance_journal', 'profile_balance_journal_append_only',
          'public.reject_billing_append_only_mutation()'),
        ('job_balance_movements', 'job_balance_movements_append_only',
          'public.reject_billing_append_only_mutation()'),
        ('jobs', 'jobs_reserve_admission', 'public.reserve_job_admission()'),
        ('jobs', 'jobs_billing_contract_guard',
          'public.enforce_job_billing_contract()')
      ) as required_trigger(table_name, trigger_name, function_name)
      where not exists (
        select 1
        from pg_trigger as installed_trigger
        where installed_trigger.tgrelid =
            to_regclass('public.' || required_trigger.table_name)
          and installed_trigger.tgname = required_trigger.trigger_name
          and installed_trigger.tgfoid =
            to_regprocedure(required_trigger.function_name)
          and not installed_trigger.tgisinternal
          and installed_trigger.tgenabled in ('O', 'A')
      )
    )
    and exists (
      select 1
      from pg_trigger as settlement_trigger
      join pg_constraint as settlement_constraint
        on settlement_constraint.oid = settlement_trigger.tgconstraint
      where settlement_trigger.tgrelid = 'public.jobs'::regclass
        and settlement_trigger.tgname = 'jobs_settle_admission'
        and settlement_trigger.tgfoid =
          to_regprocedure('public.settle_job_admission_on_terminal()')
        and not settlement_trigger.tgisinternal
        and settlement_trigger.tgenabled in ('O', 'A')
        and settlement_constraint.condeferrable
        and settlement_constraint.condeferred
    )
    and exists (
      select 1
      from public.billing_reconciliation_snapshots
      where singleton
        and generation > 0
        and healthy
        and metrics @> jsonb_build_object(
          'healthy', true,
          'releaseReady', true,
          'releaseBlockers', 0,
          'totalMismatches', 0
        )
        and generated_at >= statement_timestamp() - interval '10 minutes'
    );
$$;
revoke all on function public.runtime_healthcheck_v13()
  from public, anon, authenticated, service_role;
grant execute on function public.runtime_healthcheck_v13() to service_role;

-- Seed the constant-time gate only after every backfill and invariant trigger is
-- installed. An unhealthy snapshot commits as evidence but blocks new work and
-- the release preflight until legacy Jobs drain or mismatches are repaired.
select public.refresh_billing_reconciliation_v1();

commit;
