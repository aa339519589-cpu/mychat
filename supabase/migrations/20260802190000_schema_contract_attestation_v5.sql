-- Seal the service-role claim context repair and all prior migrations.
begin;

do $$
begin
  if not public.runtime_healthcheck_v16() then
    raise exception 'schema_contract_v5_requires_runtime_v16'
      using errcode = '55000';
  end if;

  if to_regprocedure('public.assert_agent_confirmation_actor(uuid)') is null
     or to_regprocedure('public.verify_schema_contract_v4(integer,text,integer)') is null then
    raise exception 'schema_contract_v5_requires_service_role_repair'
      using errcode = '55000';
  end if;

  insert into public.schema_contract_attestations(
    contract_version, manifest_sha256, migration_count
  ) values (
    5,
    '69e4973cfac2b9532f27b784257df991e09796c1bdf8a6872297806de0db4d74',
    51
  ) on conflict (contract_version) do nothing;

  if not exists (
    select 1 from public.schema_contract_attestations
    where contract_version = 5
      and manifest_sha256 = '69e4973cfac2b9532f27b784257df991e09796c1bdf8a6872297806de0db4d74'
      and migration_count = 51
  ) then
    raise exception 'schema_contract_v5_attestation_conflict'
      using errcode = '55000';
  end if;
end;
$$;

create or replace function public.verify_schema_contract_v5(
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
    and input_contract_version = 5
    and input_manifest_sha256 ~ '^[0-9a-f]{64}$'
    and input_migration_count = 51
    and to_regprocedure('public.assert_agent_confirmation_actor(uuid)') is not null
    and to_regprocedure('public.verify_schema_contract_v4(integer,text,integer)') is not null
    and exists (
      select 1 from public.schema_contract_attestations
      where contract_version = input_contract_version
        and manifest_sha256 = input_manifest_sha256
        and migration_count = input_migration_count
    )
    and has_function_privilege(
      'service_role',
      'public.verify_schema_contract_v5(integer,text,integer)', 'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'public.verify_schema_contract_v5(integer,text,integer)', 'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'public.verify_schema_contract_v5(integer,text,integer)', 'EXECUTE'
    );
$$;

revoke all on function public.verify_schema_contract_v5(integer,text,integer)
  from public, anon, authenticated, service_role;
grant execute on function public.verify_schema_contract_v5(integer,text,integer)
  to service_role;

comment on function public.verify_schema_contract_v5(integer,text,integer) is
  'Fails closed unless runtime v16 and the exact v5 migration contract are installed.';

commit;
