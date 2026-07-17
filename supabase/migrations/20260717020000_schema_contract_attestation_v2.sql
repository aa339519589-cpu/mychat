-- Seal platform authority v2 while retaining the v1 attestation and verifier
-- for rolling rollback compatibility.
begin;

do $$
begin
  if not public.runtime_healthcheck_v15() then
    raise exception 'schema_contract_v2_requires_runtime_v15' using errcode = '55000';
  end if;

  insert into public.schema_contract_attestations(
    contract_version, manifest_sha256, migration_count
  ) values (
    2,
    'c0c1dd9dcf788761cae5ac5a0bcb3ddd49e13ab8c59638e2c91d53ce1c5fcacc',
    45
  ) on conflict (contract_version) do nothing;

  if not exists (
    select 1 from public.schema_contract_attestations
    where contract_version = 2
      and manifest_sha256 = 'c0c1dd9dcf788761cae5ac5a0bcb3ddd49e13ab8c59638e2c91d53ce1c5fcacc'
      and migration_count = 45
  ) then
    raise exception 'schema_contract_v2_attestation_conflict' using errcode = '55000';
  end if;
end;
$$;

create or replace function public.verify_schema_contract_v2(
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
  select public.runtime_healthcheck_v15()
    and input_contract_version = 2
    and input_manifest_sha256 ~ '^[0-9a-f]{64}$'
    and input_migration_count > 0
    and exists (
      select 1 from public.schema_contract_attestations
      where contract_version = input_contract_version
        and manifest_sha256 = input_manifest_sha256
        and migration_count = input_migration_count
    )
    and exists (
      select 1 from pg_catalog.pg_class
      where oid = 'public.schema_contract_attestations'::regclass and relrowsecurity
    )
    and exists (
      select 1 from pg_catalog.pg_trigger
      where tgrelid = 'public.schema_contract_attestations'::regclass
        and tgname = 'schema_contract_attestations_immutable'
        and tgenabled = 'O' and not tgisinternal
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
      'public.verify_schema_contract_v2(integer,text,integer)', 'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'public.verify_schema_contract_v2(integer,text,integer)', 'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'public.verify_schema_contract_v2(integer,text,integer)', 'EXECUTE'
    );
$$;
revoke all on function public.verify_schema_contract_v2(integer,text,integer)
  from public, anon, authenticated, service_role;
grant execute on function public.verify_schema_contract_v2(integer,text,integer)
  to service_role;

comment on function public.verify_schema_contract_v2(integer,text,integer) is
  'Fails closed unless platform runtime v15 and the exact v2 migration contract are installed.';

commit;
