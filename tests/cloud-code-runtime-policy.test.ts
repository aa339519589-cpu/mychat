import test from 'node:test'
import assert from 'node:assert/strict'
import { parseCodeBranch, parseCodeMode } from '../lib/code-agent/request'
import { codeCapabilities } from '../lib/code-agent/capabilities'
import { codePlanToolAllowed, executeCodePlanTool } from '../lib/code-agent/plan-policy'

test('selected branch remains literal and rejects unsafe Git refs', () => {
  assert.equal(parseCodeBranch('feature/build-102'), 'feature/build-102')
  for (const branch of ['--upload-pack=x', '../main', 'a..b', 'a@{0}', 'a b', 'a.lock', 'a//b', 'a\\b']) {
    assert.throws(() => parseCodeBranch(branch))
  }
  assert.equal(parseCodeMode('plan'), 'plan')
  assert.equal(parseCodeMode('code'), 'code')
  assert.throws(() => parseCodeMode('auto'))
})

test('Plan denies writes, shell, publication, memory and unknown tools before invocation', async () => {
  let invoked = 0
  let completed = 0
  const run = async () => { invoked++; return 'read result' }
  for (const name of ['write_files', 'edit_file', 'apply_patch', 'delete_files', 'execute', 'verify',
    'publish', 'create_repo', 'enable_pages', 'remember', 'mcp_unknown']) {
    assert.equal(codePlanToolAllowed(name), false)
    assert.match(await executeCodePlanTool(name, run, () => completed++), /已阻止/)
  }
  assert.equal(invoked, 0)
  assert.equal(await executeCodePlanTool('read_file', run, () => completed++), 'read result')
  await executeCodePlanTool('complete', run, () => completed++)
  assert.equal(invoked, 1)
  assert.equal(completed, 1)
})

test('capability configuration never claims verified cloud execution', () => {
  const configured = codeCapabilities({ NODE_ENV: 'production', E2B_API_KEY: 'test-only' })
  assert.equal(configured.execution.configured, true)
  assert.equal(configured.execution.verified, false)
  assert.equal(configured.execution.location, 'cloud')
  assert.equal(codeCapabilities({ NODE_ENV: 'production', ALLOW_UNSAFE_LOCAL_AGENT_EXECUTION: 'true' })
    .execution.backend, 'disabled')
  assert.equal(codeCapabilities({ NODE_ENV: 'test', ALLOW_UNSAFE_LOCAL_AGENT_EXECUTION: 'true' })
    .execution.location, 'local_test')
  assert.doesNotMatch(JSON.stringify(configured), /test-only/)
})
