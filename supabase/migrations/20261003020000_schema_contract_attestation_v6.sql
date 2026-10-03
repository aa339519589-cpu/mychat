-- Seal topic-based global and project memories on top of the v5 contract.
begin;

do $$
begin
  if not public.runtime_healthcheck_v16() then
    raise exception 'schema_contract_v6_requires_runtime_v16'
      using errcode = '55000';
  end if;

  if not public.verify_schema_contract_v5(
    5,
    '69e4973cfac2b9532f27b784257df991e09796c1bdf8a6872297806de0db4d74',
    51
  ) then
    raise exception 'schema_contract_v6_requires_v5_attestation'
      using errcode = '55000';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'memories'
      and column_name = 'topic' and is_nullable = 'NO'
  ) or not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'project_memories'
      and column_name = 'topic' and is_nullable = 'NO'
  ) then
    raise exception 'schema_contract_v6_requires_memory_topics'
      using errcode = '55000';
  end if;

  insert into public.schema_contract_attestations(
    contract_version, manifest_sha256, migration_count
  ) values (
    6,
    'c8a467941277a0688646bee708099765141701aa019107ec4de43caae94c0618',
    53
  ) on conflict (contract_version) do nothing;

  if not exists (
    select 1 from public.schema_contract_attestations
    where contract_version = 6
      and manifest_sha256 = 'c8a467941277a0688646bee708099765141701aa019107ec4de43caae94c0618'
      and migration_count = 53
  ) then
    raise exception 'schema_contract_v6_attestation_conflict'
      using errcode = '55000';
  end if;
end;
$$;

create or replace function public.verify_schema_contract_v6(
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
    and public.verify_schema_contract_v5(
      5,
      '69e4973cfac2b9532f27b784257df991e09796c1bdf8a6872297806de0db4d74',
      51
    )
    and input_contract_version = 6
    and input_manifest_sha256 ~ '^[0-9a-f]{64}$'
    and input_migration_count = 53
    and exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'memories'
        and column_name = 'topic' and is_nullable = 'NO'
    )
    and exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'project_memories'
        and column_name = 'topic' and is_nullable = 'NO'
    )
    and exists (
      select 1 from public.schema_contract_attestations
      where contract_version = input_contract_version
        and manifest_sha256 = input_manifest_sha256
        and migration_count = input_migration_count
    )
    and has_function_privilege(
      'service_role',
      'public.verify_schema_contract_v6(integer,text,integer)', 'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'public.verify_schema_contract_v6(integer,text,integer)', 'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'public.verify_schema_contract_v6(integer,text,integer)', 'EXECUTE'
    );
$$;

revoke all on function public.verify_schema_contract_v6(integer,text,integer)
  from public, anon, authenticated, service_role;
grant execute on function public.verify_schema_contract_v6(integer,text,integer)
  to service_role;

comment on function public.verify_schema_contract_v6(integer,text,integer) is
  'Fails closed unless runtime v16, v5, and global/project memory topics are installed.';

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
  select public.verify_schema_contract_v6(
    input_contract_version,
    input_manifest_sha256,
    input_migration_count
  );
$$;

revoke all on function public.verify_schema_contract_v3(integer,text,integer)
  from public, anon, authenticated, service_role;
grant execute on function public.verify_schema_contract_v3(integer,text,integer)
  to service_role;

comment on function public.verify_schema_contract_v3(integer,text,integer) is
  'Stable readiness entry point delegated to the exact current schema contract.';

commit;
