begin;

create or replace function public.verify_schema_contract_v10(
  input_contract_version integer, input_manifest_sha256 text, input_migration_count integer
) returns boolean language sql stable strict security definer set search_path = pg_catalog, public, pg_temp as $$
select public.verify_schema_contract_v9(9,'2692c458d54feeaa330fb2e33ba2bda4429efc0104a5e78eea1b3df131bee97d',59)
  and input_contract_version=10 and input_manifest_sha256='b8c2500aee3ef8059d6119387b9e08106175f407488a003ec982103964739a35' and input_migration_count=61
  and has_function_privilege('service_role','public.verify_schema_contract_v10(integer,text,integer)','EXECUTE')
  and not has_function_privilege('authenticated','public.verify_schema_contract_v10(integer,text,integer)','EXECUTE')
  and not has_function_privilege('anon','public.verify_schema_contract_v10(integer,text,integer)','EXECUTE')
  and to_regprocedure('public.claim_connector_oauth_refresh(uuid,uuid,uuid)') is not null
  and coalesce((select relrowsecurity from pg_class where oid='public.mcp_oauth_sessions'::regclass),false)
  and not has_table_privilege('anon','public.mcp_oauth_sessions','SELECT')
  and not has_table_privilege('authenticated','public.mcp_oauth_sessions','SELECT')
  and has_table_privilege('service_role','public.mcp_oauth_sessions','SELECT,INSERT,DELETE')
  and not has_function_privilege('authenticated','public.claim_connector_oauth_refresh(uuid,uuid,uuid)','EXECUTE')
  and has_function_privilege('service_role','public.claim_connector_oauth_refresh(uuid,uuid,uuid)','EXECUTE')
  and exists (select 1 from information_schema.columns where table_schema='public' and table_name='mcp_connectors' and column_name='auth_type')
  and exists (select 1 from public.schema_contract_attestations where contract_version=input_contract_version
    and manifest_sha256=input_manifest_sha256 and migration_count=input_migration_count);
$$;
revoke all on function public.verify_schema_contract_v10(integer,text,integer) from public,anon,authenticated;
grant execute on function public.verify_schema_contract_v10(integer,text,integer) to service_role;

insert into public.schema_contract_attestations(contract_version,manifest_sha256,migration_count)
  values (10,'b8c2500aee3ef8059d6119387b9e08106175f407488a003ec982103964739a35',61) on conflict (contract_version) do nothing;
do $$ begin
  if not public.verify_schema_contract_v10(10,'b8c2500aee3ef8059d6119387b9e08106175f407488a003ec982103964739a35',61) then
    raise exception 'schema_contract_v10_oauth_lifecycle_invalid' using errcode='55000';
  end if;
end; $$;

-- These additive migrations retain readiness for the deployed release while
-- the new application is building, and permit a code rollback without data loss.
create or replace function public.verify_schema_contract_v3(input_contract_version integer,input_manifest_sha256 text,input_migration_count integer)
returns boolean language sql stable strict security definer set search_path = pg_catalog, public, pg_temp as $$
select case input_contract_version
  when 4 then public.verify_schema_contract_v4(input_contract_version,input_manifest_sha256,input_migration_count)
  when 5 then public.verify_schema_contract_v5(input_contract_version,input_manifest_sha256,input_migration_count)
  when 6 then public.verify_schema_contract_v6(input_contract_version,input_manifest_sha256,input_migration_count)
  when 7 then public.verify_schema_contract_v7(input_contract_version,input_manifest_sha256,input_migration_count)
  when 8 then public.verify_schema_contract_v8(input_contract_version,input_manifest_sha256,input_migration_count)
  when 9 then public.verify_schema_contract_v9(input_contract_version,input_manifest_sha256,input_migration_count)
  when 10 then public.verify_schema_contract_v10(input_contract_version,input_manifest_sha256,input_migration_count)
  else false end;
$$;
revoke all on function public.verify_schema_contract_v3(integer,text,integer) from public,anon,authenticated;
grant execute on function public.verify_schema_contract_v3(integer,text,integer) to service_role;
commit;
