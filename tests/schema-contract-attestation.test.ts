import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { MIGRATION_CONTRACT } from '../lib/supabase/migration-contract'

const root = process.cwd()
const manifestPath = resolve(root, 'supabase/migrations.manifest.json')
const migrationPath = resolve(
  root,
  'supabase/migrations/20260713310000_schema_contract_attestation.sql',
)

type MigrationManifest = {
  contractVersion: number
  migrationCount: number
  contractDigest: string
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

test('generated migration manifest is closed and agrees with runtime constants', () => {
  const output = execFileSync(process.execPath, ['scripts/check-migration-contract.mjs'], {
    cwd: root,
    encoding: 'utf8',
  })
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as MigrationManifest

  assert.match(output, /Migration contract verified: 43 files, [0-9a-f]{64}/)
  assert.deepEqual(MIGRATION_CONTRACT, {
    version: manifest.contractVersion,
    migrationCount: manifest.migrationCount,
    digest: manifest.contractDigest,
  })
})

test('schema attestation is immutable, least-privileged, and bound to runtime v14', () => {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as MigrationManifest
  const migration = readFileSync(migrationPath, 'utf8')
  const exactTuple = new RegExp(
    `values\\s*\\(\\s*${manifest.contractVersion}\\s*,\\s*'${escapeRegExp(manifest.contractDigest)}'\\s*,\\s*${manifest.migrationCount}\\s*\\)`,
    'i',
  )

  assert.match(migration, exactTuple)
  assert.match(migration, /alter table public\.schema_contract_attestations enable row level security/)
  assert.match(migration, /before update or delete[\s\S]*schema_contract_attestations_immutable/)
  assert.match(migration, /raise exception 'schema_contract_attestation_is_immutable'/)
  assert.match(migration, /select public\.runtime_healthcheck_v14\(\)/)
  assert.match(migration, /security definer[\s\S]*set search_path = pg_catalog, public, pg_temp/)
  assert.match(migration, /revoke all on table public\.schema_contract_attestations[\s\S]*service_role/)
  assert.match(migration, /revoke all on function public\.verify_schema_contract_v1\(integer,text,integer\)[\s\S]*service_role/)
  assert.match(migration, /grant execute on function public\.verify_schema_contract_v1\(integer,text,integer\)[\s\S]*to service_role/)
  assert.match(migration, /SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER/g)
  assert.match(migration, /not has_function_privilege\([\s\S]*?'authenticated'/)
  assert.match(migration, /not has_function_privilege\([\s\S]*?'anon'/)
})
