import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { resolve } from 'node:path'

const root = process.cwd()

function read(path: string) {
  return readFileSync(resolve(root, path), 'utf8')
}

test('CI and Render use the supported Node runtime and strict readiness', () => {
  const packageJson = JSON.parse(read('package.json')) as { engines?: { node?: string } }
  const workflow = read('.github/workflows/verify.yml')
  const render = read('render.yaml')

  assert.equal(packageJson.engines?.node, '>=24')
  assert.match(workflow, /node-version:\s*24/)
  assert.match(workflow, /playwright install --with-deps chromium/)
  assert.match(render, /healthCheckPath:\s*\/api\/ready/)
  assert.match(render, /key:\s*NODE_VERSION\s*\n\s*value:\s*24/)
})

test('runtime readiness is defined after and checks every scaling primitive', () => {
  const migration = read('supabase/migrations/20260713030000_runtime_scaling.sql')
  const triggerIndex = migration.indexOf('create trigger preserve_chat_generation_terminal_status')
  const healthIndex = migration.indexOf('create or replace function public.runtime_healthcheck()')

  assert.ok(triggerIndex >= 0)
  assert.ok(healthIndex > triggerIndex)
  assert.match(migration, /to_regclass\('public\.api_rate_limits'\)/)
  assert.match(migration, /to_regprocedure\('public\.consume_api_rate_limit\(text,integer,integer\)'\)/)
  assert.match(migration, /column_name = 'cancel_requested_at'/)
  assert.match(migration, /tgname = 'preserve_chat_generation_terminal_status'/)
  assert.match(migration, /has_function_privilege\([\s\S]*?'service_role'/)
})
