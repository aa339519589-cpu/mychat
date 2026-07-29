-- Seal direct chat admission v2 while retaining prior attestations for
-- immutable release evidence.
begin;

do $$
begin
  if not public.runtime_healthcheck_v16() then
    raise exception 'schema_contract_v3_requires_runtime_v16'
      using errcode = '55000';
  end if;

  insert into public.schema_contract_attestations(
    contract_version, manifest_sha256, migration_count
  ) values (
    3,
    '469579b5140dfe314e118405847128c6d7288fa605238275f48b568372d444f5',
    47
  ) on conflict (contract_version) do nothing;

  if not exists (
    select 1 from public.schema_contract_attestations
    where contract_version = 3
      and manifest_sha256 = '469579b5140dfe314e118405847128c6d7288fa605238275f48b568372d444f5'
      and migration_count = 47
  ) then
    raise exception 'schema_contract_v3_attestation_conflict'
      using errcode = '55000';
  end if;
end;
$$;

create or replace function public.verify_schema_contract_v3(
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
  select public.runtime_healthcheck_v16()
    and input_contract_version = 3
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
      where oid = 'public.schema_contract_attestations'::regclass
        and relrowsecurity
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
      'public.verify_schema_contract_v3(integer,text,integer)', 'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'public.verify_schema_contract_v3(integer,text,integer)', 'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'public.verify_schema_contract_v3(integer,text,integer)', 'EXECUTE'
    );
$$;

revoke all on function public.verify_schema_contract_v3(integer,text,integer)
  from public, anon, authenticated, service_role;
grant execute on function public.verify_schema_contract_v3(integer,text,integer)
  to service_role;

comment on function public.verify_schema_contract_v3(integer,text,integer) is
  'Fails closed unless runtime v16 and the exact v3 migration contract are installed.';

commit;
