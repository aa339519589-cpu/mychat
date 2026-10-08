import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { codeCapabilities } from '../lib/code-agent/capabilities'

test('workspace diff advertises a versioned read-only contract without claiming execution is verified', () => {
  for (const environment of [{ NODE_ENV: 'production' }, { NODE_ENV: 'test', ALLOW_UNSAFE_LOCAL_AGENT_EXECUTION: 'true' }]) {
    const capabilities = codeCapabilities(environment)
    assert.deepEqual(capabilities.workspaceDiff, {
      schemaVersion: 1, formats: ['cas-change-summary', 'unified'], requiresSnapshotBinding: true,
      maxFileBytes: 262144, maxPatchBytes: 1048576,
    })
    assert.equal(capabilities.execution.verified, false)
    assert.equal(capabilities.schemaVersion, 1)
    assert.equal(capabilities.durableQueue, true)
    assert.deepEqual(capabilities.modes, ['plan', 'code'])
    assert.equal(capabilities.planReadOnly, true)
  }
})

test('advertised bounds match the actual opt-in route and default diff engine limits', () => {
  const root = new URL('../', import.meta.url)
  const route = readFileSync(new URL('lib/agent/workspace-unified-diff-route.ts', root), 'utf8')
  const engine = readFileSync(new URL('lib/agent/workspace-text-diff.ts', root), 'utf8')
  const capabilities = codeCapabilities({ NODE_ENV: 'test' }).workspaceDiff
  for (const [source, prefix] of [[route, 'MAX'], [engine, 'DEFAULT']]) {
    const file = source.match(new RegExp('const ' + prefix + '_FILE_BYTES = (\\d+) \\* (\\d+)'))
    const patch = source.match(new RegExp('const ' + prefix + '_PATCH_BYTES = (\\d+) \\* (\\d+)'))
    assert.ok(file)
    assert.ok(patch)
    assert.equal(Number(file[1]) * Number(file[2]), capabilities.maxFileBytes)
    assert.equal(Number(patch[1]) * Number(patch[2]), capabilities.maxPatchBytes)
  }
  assert.match(route, /query\.get\('format'\) !== 'unified'/)
})
