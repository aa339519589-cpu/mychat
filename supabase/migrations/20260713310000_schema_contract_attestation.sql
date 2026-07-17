-- Seal the production schema against the repository's immutable migration
-- manifest without pretending that historical manual SQL has managed history.
begin;

create table if not exists public.schema_contract_attestations (
  contract_version integer primary key
    check (contract_version > 0),
  manifest_sha256 text not null
    check (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  migration_count integer not null
    check (migration_count > 0),
  attested_at timestamptz not null default clock_timestamp()
);

alter table public.schema_contract_attestations enable row level security;
revoke all on table public.schema_contract_attestations
  from public, anon, authenticated, service_role;

create or replace function public.reject_schema_contract_attestation_mutation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  raise exception 'schema_contract_attestation_is_immutable' using errcode = '55000';
end;
$$;
revoke all on function public.reject_schema_contract_attestation_mutation()
  from public, anon, authenticated, service_role;

drop trigger if exists schema_contract_attestations_immutable
  on public.schema_contract_attestations;
create trigger schema_contract_attestations_immutable
before update or delete on public.schema_contract_attestations
for each row execute function public.reject_schema_contract_attestation_mutation();

do $$
begin
  if not public.runtime_healthcheck_v14() then
    raise exception 'schema_contract_requires_runtime_v14' using errcode = '55000';
  end if;

  insert into public.schema_contract_attestations (
    contract_version,
    manifest_sha256,
    migration_count
  ) values (
    1,
    'e5479e42cbba7c439a1a31ec3325344625f740d2cca37c3865dc4af00243dc0d',
    43
  ) on conflict (contract_version) do nothing;

  if not exists (
    select 1
    from public.schema_contract_attestations
    where contract_version = 1
      and manifest_sha256 = 'e5479e42cbba7c439a1a31ec3325344625f740d2cca37c3865dc4af00243dc0d'
      and migration_count = 43
  ) then
    raise exception 'schema_contract_attestation_conflict' using errcode = '55000';
  end if;
end;
$$;

create or replace function public.verify_schema_contract_v1(
  input_contract_version integer,
  input_manifest_sha256 text,
  input_migration_count integer
)
returns boolean
language sql
stable
strict
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select public.runtime_healthcheck_v14()
    and input_contract_version > 0
    and input_manifest_sha256 ~ '^[0-9a-f]{64}$'
    and input_migration_count > 0
    and exists (
      select 1
      from public.schema_contract_attestations
      where contract_version = input_contract_version
        and manifest_sha256 = input_manifest_sha256
        and migration_count = input_migration_count
    )
    and exists (
      select 1
      from pg_catalog.pg_class
      where oid = 'public.schema_contract_attestations'::regclass
        and relrowsecurity
    )
    and exists (
      select 1
      from pg_catalog.pg_trigger
      where tgrelid = 'public.schema_contract_attestations'::regclass
        and tgname = 'schema_contract_attestations_immutable'
        and tgenabled = 'O'
        and not tgisinternal
    )
    and not has_table_privilege(
      'service_role', 'public.schema_contract_attestations',
      'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
    )
    and not has_table_privilege(
      'authenticated', 'public.schema_contract_attestations',
      'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
    )
    and not has_table_privilege(
      'anon', 'public.schema_contract_attestations',
      'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
    )
    and has_function_privilege(
      'service_role',
      'public.verify_schema_contract_v1(integer,text,integer)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'public.verify_schema_contract_v1(integer,text,integer)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'public.verify_schema_contract_v1(integer,text,integer)',
      'EXECUTE'
    );
$$;
revoke all on function public.verify_schema_contract_v1(integer,text,integer)
  from public, anon, authenticated, service_role;
grant execute on function public.verify_schema_contract_v1(integer,text,integer)
  to service_role;

comment on table public.schema_contract_attestations is
  'Append-only attestations that bind a validated runtime schema to a repository migration manifest.';
comment on function public.verify_schema_contract_v1(integer,text,integer) is
  'Fails closed unless runtime v14 and the exact immutable migration contract are installed.';

commit;
