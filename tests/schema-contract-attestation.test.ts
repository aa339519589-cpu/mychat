import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { MIGRATION_CONTRACT } from '../lib/supabase/migration-contract'

const root = process.cwd()
const manifestPath = resolve(root, 'supabase/migrations.manifest.json')

type MigrationManifest = {
  contractVersion: number
  migrationCount: number
  contractDigest: string
  sealMigration: string
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

  assert.match(output, new RegExp(
    `Migration contract verified: ${manifest.migrationCount} files, [0-9a-f]{64}`,
  ))
  assert.deepEqual(MIGRATION_CONTRACT, {
    version: manifest.contractVersion,
    migrationCount: manifest.migrationCount,
    digest: manifest.contractDigest,
  })
})

test('current schema attestation is immutable, least-privileged, and bound to runtime v16', () => {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as MigrationManifest
  const migrationPath = resolve(root, 'supabase/migrations', manifest.sealMigration)
  const migration = readFileSync(migrationPath, 'utf8')
  const version = manifest.contractVersion
  const functionName = `verify_schema_contract_v${version}`
  const exactTuple = new RegExp(
    `values\\s*\\(\\s*${version}\\s*,\\s*'${escapeRegExp(manifest.contractDigest)}'\\s*,\\s*${manifest.migrationCount}\\s*\\)`,
    'i',
  )

  assert.match(migration, exactTuple)
  const originalSeal = readFileSync(resolve(
    root,
    'supabase/migrations/20260713310000_schema_contract_attestation.sql',
  ), 'utf8')
  assert.match(originalSeal, /alter table public\.schema_contract_attestations enable row level security/)
  assert.match(originalSeal, /before update or delete[\s\S]*schema_contract_attestations_immutable/)
  assert.match(originalSeal, /raise exception 'schema_contract_attestation_is_immutable'/)
  assert.match(migration, /select public\.runtime_healthcheck_v16\(\)/)
  assert.match(migration, /security definer[\s\S]*set search_path = pg_catalog, public, pg_temp/)
  assert.match(originalSeal, /revoke all on table public\.schema_contract_attestations[\s\S]*service_role/)
  assert.match(migration, new RegExp(`revoke all on function public\\.${functionName}\\(integer,text,integer\\)[\\s\\S]*service_role`))
  assert.match(migration, new RegExp(`grant execute on function public\\.${functionName}\\(integer,text,integer\\)[\\s\\S]*to service_role`))
  assert.match(migration, /not has_function_privilege\([\s\S]*?'authenticated'/)
  assert.match(migration, /not has_function_privilege\([\s\S]*?'anon'/)
})
