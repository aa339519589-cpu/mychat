-- Seal the OpenRouter catalog and lifetime medium-model trial quota.
begin;

do $$
begin
  if not public.runtime_healthcheck_v16() then
    raise exception 'schema_contract_v4_requires_runtime_v16'
      using errcode = '55000';
  end if;

  if to_regclass('public.medium_model_trial_calls') is null
     or to_regprocedure('public.reserve_medium_model_trial(uuid,uuid,text)') is null
     or to_regprocedure('public.release_medium_model_trial(uuid,uuid)') is null then
    raise exception 'schema_contract_v4_requires_medium_model_trial_quota'
      using errcode = '55000';
  end if;

  insert into public.schema_contract_attestations(
    contract_version, manifest_sha256, migration_count
  ) values (
    4,
    '68fd46dfeac7cebc79f5b9ba4858a416c71188982d48cc5b9a3428bdea0af32e',
    49
  ) on conflict (contract_version) do nothing;

  if not exists (
    select 1 from public.schema_contract_attestations
    where contract_version = 4
      and manifest_sha256 = '68fd46dfeac7cebc79f5b9ba4858a416c71188982d48cc5b9a3428bdea0af32e'
      and migration_count = 49
  ) then
    raise exception 'schema_contract_v4_attestation_conflict'
      using errcode = '55000';
  end if;
end;
$$;

create or replace function public.verify_schema_contract_v4(
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
    and input_contract_version = 4
    and input_manifest_sha256 ~ '^[0-9a-f]{64}$'
    and input_migration_count = 49
    and to_regclass('public.medium_model_trial_calls') is not null
    and to_regprocedure('public.reserve_medium_model_trial(uuid,uuid,text)') is not null
    and to_regprocedure('public.release_medium_model_trial(uuid,uuid)') is not null
    and exists (
      select 1 from public.schema_contract_attestations
      where contract_version = input_contract_version
        and manifest_sha256 = input_manifest_sha256
        and migration_count = input_migration_count
    )
    and has_function_privilege(
      'service_role',
      'public.verify_schema_contract_v4(integer,text,integer)', 'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'public.verify_schema_contract_v4(integer,text,integer)', 'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'public.verify_schema_contract_v4(integer,text,integer)', 'EXECUTE'
    );
$$;

revoke all on function public.verify_schema_contract_v4(integer,text,integer)
  from public, anon, authenticated, service_role;
grant execute on function public.verify_schema_contract_v4(integer,text,integer)
  to service_role;

comment on function public.verify_schema_contract_v4(integer,text,integer) is
  'Fails closed unless runtime v16 and the exact v4 migration contract are installed.';

commit;
