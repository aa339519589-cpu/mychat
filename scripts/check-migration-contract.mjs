#!/usr/bin/env node

import { createHash } from 'node:crypto'
import {
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const migrationsDirectory = resolve(root, 'supabase/migrations')
const manifestPath = resolve(root, 'supabase/migrations.manifest.json')
const defaultSealMigration = '20260713310000_schema_contract_attestation.sql'

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function compareAscii(left, right) {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function migrationFiles() {
  return readdirSync(migrationsDirectory)
    .filter(name => name.endsWith('.sql'))
    .sort(compareAscii)
}

function migrationEntries(sealMigration) {
  return migrationFiles()
    .filter(name => name !== sealMigration)
    .map(file => ({
      file,
      sha256: sha256(readFileSync(resolve(migrationsDirectory, file))),
    }))
}

function canonicalPayload({
  schemaVersion,
  contractVersion,
  sealMigration,
  migrations,
}) {
  return {
    schemaVersion,
    contractVersion,
    sealMigration,
    migrationCount: migrations.length,
    migrations,
  }
}

function buildManifest({
  schemaVersion = 1,
  contractVersion = 1,
  sealMigration = defaultSealMigration,
} = {}) {
  const migrations = migrationEntries(sealMigration)
  const payload = canonicalPayload({
    schemaVersion,
    contractVersion,
    sealMigration,
    migrations,
  })
  return {
    ...payload,
    contractDigest: sha256(JSON.stringify(payload)),
  }
}

function fail(message) {
  throw new Error(`Migration contract verification failed: ${message}`)
}

function assertClosedKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`)
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) fail(`${label} has unexpected fields`)
}

function verifyManifest(manifest) {
  assertClosedKeys(manifest, [
    'schemaVersion',
    'contractVersion',
    'sealMigration',
    'migrationCount',
    'migrations',
    'contractDigest',
  ], 'manifest')
  if (manifest.schemaVersion !== 1) fail('unsupported schemaVersion')
  if (!Number.isSafeInteger(manifest.contractVersion) || manifest.contractVersion < 1) {
    fail('contractVersion must be a positive integer')
  }
  if (!/^\d{8,14}_[a-z0-9_]+\.sql$/.test(manifest.sealMigration)) {
    fail('sealMigration is malformed')
  }
  if (!Array.isArray(manifest.migrations) || manifest.migrations.length === 0) {
    fail('migrations must be a non-empty array')
  }
  if (manifest.migrationCount !== manifest.migrations.length) {
    fail('migrationCount does not match the manifest')
  }
  if (!/^[0-9a-f]{64}$/.test(manifest.contractDigest)) fail('contractDigest is malformed')

  let previous = ''
  const names = new Set()
  for (const [index, entry] of manifest.migrations.entries()) {
    assertClosedKeys(entry, ['file', 'sha256'], `migrations[${index}]`)
    if (!/^\d{8,14}_[a-z0-9_]+\.sql$/.test(entry.file)) fail(`invalid migration filename: ${entry.file}`)
    if (!/^[0-9a-f]{64}$/.test(entry.sha256)) fail(`invalid migration digest: ${entry.file}`)
    if (compareAscii(entry.file, previous) <= 0) fail('migration entries are not strictly sorted and unique')
    if (compareAscii(entry.file, manifest.sealMigration) >= 0) fail('seal migration must follow every attested migration')
    names.add(entry.file)
    previous = entry.file
  }
  if (names.size !== manifest.migrations.length) fail('duplicate migration filename')

  const files = migrationFiles()
  const expectedFiles = [...names, manifest.sealMigration].sort(compareAscii)
  if (JSON.stringify(files) !== JSON.stringify(expectedFiles)) {
    fail('migration directory differs from the closed manifest plus its seal')
  }

  const expected = buildManifest({
    schemaVersion: manifest.schemaVersion,
    contractVersion: manifest.contractVersion,
    sealMigration: manifest.sealMigration,
  })
  if (JSON.stringify(manifest.migrations) !== JSON.stringify(expected.migrations)) {
    fail('one or more attested migration files changed')
  }
  if (manifest.contractDigest !== expected.contractDigest) fail('contractDigest does not match canonical content')

  const manifestSource = readFileSync(manifestPath, 'utf8')
  if (manifestSource !== `${JSON.stringify(manifest, null, 2)}\n`) {
    fail('manifest JSON is not canonical')
  }

  const seal = readFileSync(resolve(migrationsDirectory, manifest.sealMigration), 'utf8')
  const escapedDigest = manifest.contractDigest.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const binding = new RegExp(
    `values\\s*\\(\\s*${manifest.contractVersion}\\s*,\\s*'${escapedDigest}'\\s*,\\s*${manifest.migrationCount}\\s*\\)`,
    'i',
  )
  if (!binding.test(seal)) fail('seal migration does not bind the exact contract tuple')
}

if (process.argv.includes('--write')) {
  const manifest = buildManifest()
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`Wrote migration contract ${manifest.contractDigest}`)
} else {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  verifyManifest(manifest)
  console.log(`Migration contract verified: ${manifest.migrationCount} files, ${manifest.contractDigest}`)
}
