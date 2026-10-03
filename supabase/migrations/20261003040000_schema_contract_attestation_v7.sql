-- Seal sensitive-memory consent and account-scoped reset operations.
begin;

do $$
begin
  if not public.runtime_healthcheck_v16() then
    raise exception 'schema_contract_v7_requires_runtime_v16'
      using errcode = '55000';
  end if;

  if not public.verify_schema_contract_v6(
    6,
    'c8a467941277a0688646bee708099765141701aa019107ec4de43caae94c0618',
    53
  ) then
    raise exception 'schema_contract_v7_requires_v6_attestation'
      using errcode = '55000';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles'
      and column_name = 'sensitive_memory_enabled' and is_nullable = 'NO'
  ) or not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'memories'
      and column_name = 'sensitive' and is_nullable = 'NO'
  ) or not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'project_memories'
      and column_name = 'sensitive' and is_nullable = 'NO'
  ) then
    raise exception 'schema_contract_v7_requires_sensitive_memory_columns'
      using errcode = '55000';
  end if;

  if to_regprocedure('public.set_user_sensitive_memory_enabled(uuid,boolean)') is null
     or to_regprocedure('public.reset_user_memories(uuid)') is null
     or to_regprocedure('public.guard_sensitive_memory_write()') is null
     or to_regprocedure('public.guard_sensitive_memory_preference()') is null then
    raise exception 'schema_contract_v7_requires_memory_management_functions'
      using errcode = '55000';
  end if;

  insert into public.schema_contract_attestations(
    contract_version, manifest_sha256, migration_count
  ) values (
    7,
    '181ca92677d727d9b86cec2e5329bdd62158f3bd3f61f95900e853c42a0de224',
    55
  ) on conflict (contract_version) do nothing;

  if not exists (
    select 1 from public.schema_contract_attestations
    where contract_version = 7
      and manifest_sha256 = '181ca92677d727d9b86cec2e5329bdd62158f3bd3f61f95900e853c42a0de224'
      and migration_count = 55
  ) then
    raise exception 'schema_contract_v7_attestation_conflict'
      using errcode = '55000';
  end if;
end;
$$;

create or replace function public.verify_schema_contract_v7(
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
    and public.verify_schema_contract_v6(
      6,
      'c8a467941277a0688646bee708099765141701aa019107ec4de43caae94c0618',
      53
    )
    and input_contract_version = 7
    and input_manifest_sha256 ~ '^[0-9a-f]{64}$'
    and input_migration_count = 55
    and exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'profiles'
        and column_name = 'sensitive_memory_enabled' and is_nullable = 'NO'
    )
    and exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'memories'
        and column_name = 'sensitive' and is_nullable = 'NO'
    )
    and exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'project_memories'
        and column_name = 'sensitive' and is_nullable = 'NO'
    )
    and to_regprocedure('public.set_user_sensitive_memory_enabled(uuid,boolean)') is not null
    and to_regprocedure('public.reset_user_memories(uuid)') is not null
    and has_function_privilege(
      'service_role',
      'public.set_user_sensitive_memory_enabled(uuid,boolean)', 'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'public.set_user_sensitive_memory_enabled(uuid,boolean)', 'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'public.set_user_sensitive_memory_enabled(uuid,boolean)', 'EXECUTE'
    )
    and has_function_privilege(
      'service_role', 'public.reset_user_memories(uuid)', 'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated', 'public.reset_user_memories(uuid)', 'EXECUTE'
    )
    and not has_function_privilege(
      'anon', 'public.reset_user_memories(uuid)', 'EXECUTE'
    )
    and has_function_privilege(
      'service_role',
      'public.verify_schema_contract_v7(integer,text,integer)', 'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'public.verify_schema_contract_v7(integer,text,integer)', 'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'public.verify_schema_contract_v7(integer,text,integer)', 'EXECUTE'
    )
    and exists (
      select 1 from public.schema_contract_attestations
      where contract_version = input_contract_version
        and manifest_sha256 = input_manifest_sha256
        and migration_count = input_migration_count
    );
$$;

revoke all on function public.verify_schema_contract_v7(integer,text,integer)
  from public, anon, authenticated, service_role;
grant execute on function public.verify_schema_contract_v7(integer,text,integer)
  to service_role;

comment on function public.verify_schema_contract_v7(integer,text,integer) is
  'Fails closed unless v6 topics, sensitive-memory controls, reset RPCs, and the exact v7 manifest are installed.';

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
  select public.verify_schema_contract_v7(
    input_contract_version,
    input_manifest_sha256,
    input_migration_count
  );
$$;

revoke all on function public.verify_schema_contract_v3(integer,text,integer)
  from public, anon, authenticated, service_role;
grant execute on function public.verify_schema_contract_v3(integer,text,integer)
  to service_role;

commit;
