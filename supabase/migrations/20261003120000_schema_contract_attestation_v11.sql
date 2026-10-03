begin;
create or replace function public.verify_schema_contract_v11(input_contract_version integer,input_manifest_sha256 text,input_migration_count integer)
returns boolean language sql stable strict security definer set search_path = pg_catalog, public, pg_temp as $$
select public.verify_schema_contract_v10(10,'b8c2500aee3ef8059d6119387b9e08106175f407488a003ec982103964739a35',61)
 and input_contract_version=11 and input_manifest_sha256='dd6230a4f2aa3533f4bfac894ff38a10432c91003353535bc48eac7a11ca562d' and input_migration_count=63
 and to_regprocedure('public.admit_private_chat_v1(uuid,uuid,text,text,text,integer)') is not null
 and has_function_privilege('service_role','public.admit_private_chat_v1(uuid,uuid,text,text,text,integer)','EXECUTE')
 and not has_function_privilege('authenticated','public.admit_private_chat_v1(uuid,uuid,text,text,text,integer)','EXECUTE')
 and not has_function_privilege('anon','public.admit_private_chat_v1(uuid,uuid,text,text,text,integer)','EXECUTE')
 and exists(select 1 from pg_trigger where tgrelid='public.jobs'::regclass and tgname='jobs_private_metadata_guard' and not tgisinternal)
 and exists(select 1 from pg_trigger where tgrelid='public.job_events'::regclass and tgname='private_event_metadata_guard' and not tgisinternal)
 and exists(select 1 from public.schema_contract_attestations where contract_version=11 and manifest_sha256=input_manifest_sha256 and migration_count=input_migration_count);
$$;
revoke all on function public.verify_schema_contract_v11(integer,text,integer) from public,anon,authenticated,service_role;
grant execute on function public.verify_schema_contract_v11(integer,text,integer) to service_role;
insert into public.schema_contract_attestations(contract_version,manifest_sha256,migration_count)
 values (11,'dd6230a4f2aa3533f4bfac894ff38a10432c91003353535bc48eac7a11ca562d',63) on conflict(contract_version) do nothing;
do $$ begin
 if not public.verify_schema_contract_v11(11,'dd6230a4f2aa3533f4bfac894ff38a10432c91003353535bc48eac7a11ca562d',63) then
 raise exception 'schema_contract_v11_private_chat_invalid' using errcode='55000'; end if;
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
  when 11 then public.verify_schema_contract_v11(input_contract_version,input_manifest_sha256,input_migration_count)
  else false end;
$$;
revoke all on function public.verify_schema_contract_v3(integer,text,integer) from public,anon,authenticated;
grant execute on function public.verify_schema_contract_v3(integer,text,integer) to service_role;
commit;
