-- Seal authenticated, service-only remote MCP connector storage.
begin;

do $$
begin
  if not public.verify_schema_contract_v8(
    8,
    'fd39067a1157b2146d1cf3ceb0d16c3c977255265cee5970827105fb818c9523',
    57
  ) then
    raise exception 'schema_contract_v9_requires_v8_attestation'
      using errcode = '55000';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'mcp_connectors'
      and column_name = 'credential_ciphertext' and data_type = 'text'
      and is_nullable = 'YES'
  ) or not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'mcp_connectors'
      and column_name = 'tools' and data_type = 'jsonb'
      and is_nullable = 'NO'
  ) or not coalesce((
    select relrowsecurity from pg_class
    where oid = 'public.mcp_connectors'::regclass
  ), false) then
    raise exception 'schema_contract_v9_requires_remote_mcp_connector_storage'
      using errcode = '55000';
  end if;

  if has_table_privilege('anon', 'public.mcp_connectors', 'SELECT')
     or has_table_privilege('authenticated', 'public.mcp_connectors', 'SELECT')
     or not has_table_privilege('service_role', 'public.mcp_connectors', 'SELECT')
     or not has_table_privilege('service_role', 'public.mcp_connectors', 'INSERT')
     or not has_table_privilege('service_role', 'public.mcp_connectors', 'UPDATE')
     or not has_table_privilege('service_role', 'public.mcp_connectors', 'DELETE') then
    raise exception 'schema_contract_v9_requires_service_only_connector_access'
      using errcode = '55000';
  end if;

  insert into public.schema_contract_attestations(
    contract_version, manifest_sha256, migration_count
  ) values (
    9,
    '2692c458d54feeaa330fb2e33ba2bda4429efc0104a5e78eea1b3df131bee97d',
    59
  ) on conflict (contract_version) do nothing;

  if not exists (
    select 1 from public.schema_contract_attestations
    where contract_version = 9
      and manifest_sha256 = '2692c458d54feeaa330fb2e33ba2bda4429efc0104a5e78eea1b3df131bee97d'
      and migration_count = 59
  ) then
    raise exception 'schema_contract_v9_attestation_conflict'
      using errcode = '55000';
  end if;
end;
$$;

create or replace function public.verify_schema_contract_v9(
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
      8,
      'fd39067a1157b2146d1cf3ceb0d16c3c977255265cee5970827105fb818c9523',
      57
    )
    and input_contract_version = 9
    and input_manifest_sha256 = '2692c458d54feeaa330fb2e33ba2bda4429efc0104a5e78eea1b3df131bee97d'
    and input_migration_count = 59
    and exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'mcp_connectors'
        and column_name = 'credential_ciphertext' and data_type = 'text'
        and is_nullable = 'YES'
    )
    and exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'mcp_connectors'
        and column_name = 'tools' and data_type = 'jsonb'
        and is_nullable = 'NO'
    )
    and coalesce((
      select relrowsecurity from pg_class
      where oid = 'public.mcp_connectors'::regclass
    ), false)
    and has_table_privilege('service_role', 'public.mcp_connectors', 'SELECT')
    and has_table_privilege('service_role', 'public.mcp_connectors', 'INSERT')
    and has_table_privilege('service_role', 'public.mcp_connectors', 'UPDATE')
    and has_table_privilege('service_role', 'public.mcp_connectors', 'DELETE')
    and not has_table_privilege('anon', 'public.mcp_connectors', 'SELECT')
    and not has_table_privilege('authenticated', 'public.mcp_connectors', 'SELECT')
    and has_function_privilege('service_role', 'public.verify_schema_contract_v9(integer,text,integer)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.verify_schema_contract_v9(integer,text,integer)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.verify_schema_contract_v9(integer,text,integer)', 'EXECUTE')
    and exists (
      select 1 from public.schema_contract_attestations
      where contract_version = input_contract_version
        and manifest_sha256 = input_manifest_sha256
        and migration_count = input_migration_count
    );
$$;

revoke all on function public.verify_schema_contract_v9(integer,text,integer)
  from public, anon, authenticated, service_role;
grant execute on function public.verify_schema_contract_v9(integer,text,integer)
  to service_role;

comment on function public.verify_schema_contract_v9(integer,text,integer) is
  'Fails closed unless the v8 memory protections and service-only remote MCP connector storage are installed.';

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
  select public.verify_schema_contract_v9(
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
