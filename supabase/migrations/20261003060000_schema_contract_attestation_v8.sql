-- Seal the per-conversation saved-memory control and service-only admission.
begin;

do $$
begin
  if not public.verify_schema_contract_v7(
    7,
    '181ca92677d727d9b86cec2e5329bdd62158f3bd3f61f95900e853c42a0de224',
    55
  ) then
    raise exception 'schema_contract_v8_requires_v7_attestation'
      using errcode = '55000';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'conversations'
      and column_name = 'memory_enabled' and data_type = 'boolean'
      and is_nullable = 'NO'
  ) or to_regprocedure(
    'public.admit_chat_turn_v3(uuid,uuid,boolean,uuid,text,uuid,text,jsonb,timestamptz,uuid,uuid,text,text,text,jsonb,jsonb,text,integer,boolean)'
  ) is null or to_regprocedure(
    'public.guard_conversation_memory_setting()'
  ) is null then
    raise exception 'schema_contract_v8_requires_conversation_memory_control'
      using errcode = '55000';
  end if;

  insert into public.schema_contract_attestations(
    contract_version, manifest_sha256, migration_count
  ) values (
    8,
    'fd39067a1157b2146d1cf3ceb0d16c3c977255265cee5970827105fb818c9523',
    57
  ) on conflict (contract_version) do nothing;

  if not exists (
    select 1 from public.schema_contract_attestations
    where contract_version = 8
      and manifest_sha256 = 'fd39067a1157b2146d1cf3ceb0d16c3c977255265cee5970827105fb818c9523'
      and migration_count = 57
  ) then
    raise exception 'schema_contract_v8_attestation_conflict'
      using errcode = '55000';
  end if;
end;
$$;

create or replace function public.verify_schema_contract_v8(
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
    and public.verify_schema_contract_v7(
      7,
      '181ca92677d727d9b86cec2e5329bdd62158f3bd3f61f95900e853c42a0de224',
      55
    )
    and input_contract_version = 8
    and input_manifest_sha256 ~ '^[0-9a-f]{64}$'
    and input_migration_count = 57
    and exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'conversations'
        and column_name = 'memory_enabled' and data_type = 'boolean'
        and is_nullable = 'NO'
    )
    and to_regprocedure(
      'public.admit_chat_turn_v3(uuid,uuid,boolean,uuid,text,uuid,text,jsonb,timestamptz,uuid,uuid,text,text,text,jsonb,jsonb,text,integer,boolean)'
    ) is not null
    and to_regprocedure('public.guard_conversation_memory_setting()') is not null
    and has_function_privilege(
      'service_role',
      'public.admit_chat_turn_v3(uuid,uuid,boolean,uuid,text,uuid,text,jsonb,timestamptz,uuid,uuid,text,text,text,jsonb,jsonb,text,integer,boolean)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'public.admit_chat_turn_v3(uuid,uuid,boolean,uuid,text,uuid,text,jsonb,timestamptz,uuid,uuid,text,text,text,jsonb,jsonb,text,integer,boolean)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'public.admit_chat_turn_v3(uuid,uuid,boolean,uuid,text,uuid,text,jsonb,timestamptz,uuid,uuid,text,text,text,jsonb,jsonb,text,integer,boolean)',
      'EXECUTE'
    )
    and has_function_privilege(
      'service_role', 'public.verify_schema_contract_v8(integer,text,integer)', 'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated', 'public.verify_schema_contract_v8(integer,text,integer)', 'EXECUTE'
    )
    and not has_function_privilege(
      'anon', 'public.verify_schema_contract_v8(integer,text,integer)', 'EXECUTE'
    )
    and exists (
      select 1 from public.schema_contract_attestations
      where contract_version = input_contract_version
        and manifest_sha256 = input_manifest_sha256
        and migration_count = input_migration_count
    );
$$;

revoke all on function public.verify_schema_contract_v8(integer,text,integer)
  from public, anon, authenticated, service_role;
grant execute on function public.verify_schema_contract_v8(integer,text,integer)
  to service_role;

comment on function public.verify_schema_contract_v8(integer,text,integer) is
  'Fails closed unless v7 memory safeguards and per-conversation memory controls are installed.';

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
  select public.verify_schema_contract_v8(
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
