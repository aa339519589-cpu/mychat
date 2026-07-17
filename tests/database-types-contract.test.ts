import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

const root = process.cwd()
const read = (path: string) => readFileSync(resolve(root, path), 'utf8')

test('database types are generated from the complete canonical PostgreSQL schema', () => {
  const replay = read('scripts/verify-database-types-pg16.sh')
  const generator = read('scripts/generate-database-types.mjs')
  const generated = read('lib/supabase/database.types.ts')

  assert.match(replay, /-f "\$ROOT\/supabase\/schema\.sql"/)
  assert.match(replay, /-f "\$ROOT\/supabase\/agent-tasks\.sql"/)
  assert.match(replay, /-f "\$ROOT\/supabase\/baseline\/20260623_legacy_compatibility\.sql"/)
  assert.match(replay, /migrations\.manifest\.json/)
  assert.match(replay, /20260717020000_schema_contract_attestation_v2\.sql/)
  assert.match(replay, /generate-database-types\.mjs" --database "\$DB" "\$MODE"/)
  assert.match(generator, /current !== generated/)
  assert.match(generator, /Generated database types are stale/)
  assert.match(generated, /^\/\/ Generated from the canonical PostgreSQL 16 schema\./)
  assert.match(generated, /"messages": \{/)
  assert.match(generated, /"verify_schema_contract_v2": \{/)
})

test('database type drift is a required digest-pinned verification gate', () => {
  const packageJson = JSON.parse(read('package.json')) as { scripts?: Record<string, string> }
  const verify = packageJson.scripts?.verify ?? ''
  const workflow = read('.github/workflows/verify.yml')

  assert.equal(
    packageJson.scripts?.['database:types:check'],
    'bash scripts/verify-database-types-pg16.sh --check',
  )
  assert.match(verify, /npm run database:types:check/)
  assert.ok(verify.indexOf('npm run database:types:check') < verify.indexOf('npm run build'))
  assert.match(
    workflow,
    /pgvector\/pgvector:pg16@sha256:1d533553fefe4f12e5d80c7b80622ba0c382abb5758856f52983d8789179f0fb/,
  )
  assert.match(workflow, /run: npm run verify/)
})
