#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const migrationsDirectory = resolve(root, 'supabase/migrations')
const manifestPath = resolve(root, 'supabase/migrations.manifest.json')
const sealMigration = '20260801020000_schema_contract_attestation_v4.sql'
const contractVersion = 4
const schemaVersion = 1

const sha256 = value => createHash('sha256').update(value).digest('hex')
const migrations = readdirSync(migrationsDirectory)
  .filter(name => name.endsWith('.sql') && name !== sealMigration)
  .sort()
  .map(file => ({
    file,
    sha256: sha256(readFileSync(resolve(migrationsDirectory, file))),
  }))

const payload = {
  schemaVersion,
  contractVersion,
  sealMigration,
  migrationCount: migrations.length,
  migrations,
}
const contractDigest = sha256(JSON.stringify(payload))
const manifest = { ...payload, contractDigest }
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

const seal = `-- Seal the OpenRouter catalog and lifetime medium-model trial quota.\nbegin;\n\ndo $$\nbegin\n  if not public.runtime_healthcheck_v16() then\n    raise exception 'schema_contract_v4_requires_runtime_v16'\n      using errcode = '55000';\n  end if;\n\n  if to_regclass('public.medium_model_trial_calls') is null\n     or to_regprocedure('public.reserve_medium_model_trial(uuid,uuid,text)') is null\n     or to_regprocedure('public.release_medium_model_trial(uuid,uuid)') is null then\n    raise exception 'schema_contract_v4_requires_medium_model_trial_quota'\n      using errcode = '55000';\n  end if;\n\n  insert into public.schema_contract_attestations(\n    contract_version, manifest_sha256, migration_count\n  ) values (\n    ${contractVersion},\n    '${contractDigest}',\n    ${migrations.length}\n  ) on conflict (contract_version) do nothing;\n\n  if not exists (\n    select 1 from public.schema_contract_attestations\n    where contract_version = ${contractVersion}\n      and manifest_sha256 = '${contractDigest}'\n      and migration_count = ${migrations.length}\n  ) then\n    raise exception 'schema_contract_v4_attestation_conflict'\n      using errcode = '55000';\n  end if;\nend;\n$$;\n\ncreate or replace function public.verify_schema_contract_v4(\n  input_contract_version integer,\n  input_manifest_sha256 text,\n  input_migration_count integer\n)\nreturns boolean\nlanguage sql\nstable\nstrict\nsecurity definer\nset search_path = pg_catalog, public, pg_temp\nas $$\n  select public.runtime_healthcheck_v16()\n    and input_contract_version = ${contractVersion}\n    and input_manifest_sha256 ~ '^[0-9a-f]{64}$'\n    and input_migration_count = ${migrations.length}\n    and to_regclass('public.medium_model_trial_calls') is not null\n    and to_regprocedure('public.reserve_medium_model_trial(uuid,uuid,text)') is not null\n    and to_regprocedure('public.release_medium_model_trial(uuid,uuid)') is not null\n    and exists (\n      select 1 from public.schema_contract_attestations\n      where contract_version = input_contract_version\n        and manifest_sha256 = input_manifest_sha256\n        and migration_count = input_migration_count\n    )\n    and has_function_privilege(\n      'service_role',\n      'public.verify_schema_contract_v4(integer,text,integer)', 'EXECUTE'\n    )\n    and not has_function_privilege(\n      'authenticated',\n      'public.verify_schema_contract_v4(integer,text,integer)', 'EXECUTE'\n    )\n    and not has_function_privilege(\n      'anon',\n      'public.verify_schema_contract_v4(integer,text,integer)', 'EXECUTE'\n    );\n$$;\n\nrevoke all on function public.verify_schema_contract_v4(integer,text,integer)\n  from public, anon, authenticated, service_role;\ngrant execute on function public.verify_schema_contract_v4(integer,text,integer)\n  to service_role;\n\ncomment on function public.verify_schema_contract_v4(integer,text,integer) is\n  'Fails closed unless runtime v16 and the exact v4 migration contract are installed.';\n\ncommit;\n`
writeFileSync(resolve(migrationsDirectory, sealMigration), seal)
console.log(`Generated migration contract v${contractVersion}: ${migrations.length} migrations, ${contractDigest}`)
