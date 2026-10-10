import test from 'node:test'
import assert from 'node:assert/strict'
import { parseCodeBranch, parseCodeMode } from '../lib/code-agent/request'
import { codeCapabilities } from '../lib/code-agent/capabilities'
import { readFileSync } from 'node:fs'

test('selected branch remains literal and rejects unsafe Git refs', () => {
  assert.equal(parseCodeBranch('feature/build-102'), 'feature/build-102')
  for (const branch of ['--upload-pack=x', '../main', 'a..b', 'a@{0}', 'a b', 'a.lock', 'a//b', 'a\\b']) {
    assert.throws(() => parseCodeBranch(branch))
  }
  assert.throws(() => parseCodeMode('plan'), /旧任务模式/)
  assert.equal(parseCodeMode('code'), 'code')
  assert.equal(parseCodeMode(undefined), 'code')
  assert.throws(() => parseCodeMode('auto'))
})

test('Cloud Code admission refuses disabled/local execution before accepting any job', () => {
  const route = readFileSync(new URL('../app/api/code/chat/route.ts', import.meta.url), 'utf8')
  assert.match(route, /agentExecutionBackend\(\) !== 'isolated'/)
  assert.match(route, /CODE_CLOUD_UNAVAILABLE/)
  const input = readFileSync(new URL('../lib/jobs/handlers/agent-input.ts', import.meta.url), 'utf8')
  assert.match(input, /agentExecutionBackend\(\) !== 'isolated'/)
  assert.ok(!input.includes('readOnlyPlan'))
})

test('cloud acceptance scripts request only code and Haiku; retired compatibility diagnostic cannot call a model', () => {
  for (const path of ['probe-cloud-code-workspace.mjs', 'cloud-code-mcp-acceptance.mjs']) {
    const source = readFileSync(new URL(`../scripts/${path}`, import.meta.url), 'utf8')
    assert.ok(!/DeepSeek|deepseek|createPlanSession|mode: 'plan'/.test(source))
    assert.match(source, /anthropic\/claude-haiku-5\.5/)
  }
  const retired = readFileSync(new URL('../scripts/probe-code-model-compatibility.mjs', import.meta.url), 'utf8')
  assert.ok(!/fetch\(|runTurn|runAgentLoop/.test(retired))
  assert.match(retired, /historicalOnly: true/)
})

test('capability configuration never claims verified cloud execution', () => {
  const configured = codeCapabilities({ NODE_ENV: 'production', E2B_API_KEY: 'test-only' })
  assert.equal(configured.execution.configured, true)
  assert.equal(configured.execution.verified, false)
  assert.equal(configured.execution.location, 'cloud')
  assert.equal(codeCapabilities({ NODE_ENV: 'production', ALLOW_UNSAFE_LOCAL_AGENT_EXECUTION: 'true' })
    .execution.backend, 'disabled')
  assert.equal(codeCapabilities({ NODE_ENV: 'test', ALLOW_UNSAFE_LOCAL_AGENT_EXECUTION: 'true' })
    .execution.location, 'unavailable')
  assert.equal('modes' in configured, false)
  assert.equal('planReadOnly' in configured, false)
  assert.doesNotMatch(JSON.stringify(configured), /test-only/)
})
