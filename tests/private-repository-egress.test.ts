import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { sandboxEgressForRepository } from '../lib/agent/execution-policy'
import { buildCodeTools } from '../lib/code-tools/definitions'

const options = {
  isWorkspace: true,
  executePermission: 'isolated',
  canExecute: true,
}

test('private repository agents are not offered arbitrary external network tools', () => {
  const privateNames = buildCodeTools({ ...options, allowExternalNetwork: false })
    .map(tool => tool.function.name)
  assert.equal(privateNames.includes('search'), false)
  assert.equal(privateNames.includes('fetch_url'), false)

  const publicNames = buildCodeTools({ ...options, allowExternalNetwork: true })
    .map(tool => tool.function.name)
  assert.equal(publicNames.includes('search'), true)
  assert.equal(publicNames.includes('fetch_url'), true)
})

test('private repository execute and verify paths force an empty E2B allowlist', () => {
  assert.deepEqual(sandboxEgressForRepository(true, {
    AGENT_SANDBOX_EGRESS_ALLOWLIST: 'registry.example.com',
  }), [])

  const workflowHandlers = readFileSync(new URL('../lib/code-tools/workflow-handlers.ts', import.meta.url), 'utf8')
  const isolatedShell = readFileSync(new URL('../lib/agent/isolated-shell.ts', import.meta.url), 'utf8')
  assert.match(workflowHandlers, /runInWorkspace[\s\S]*?repoIsPrivate/)
  assert.match(workflowHandlers, /runVerification[\s\S]*?repoIsPrivate/)
  assert.match(isolatedShell, /sandboxEgressForRepository\(repoIsPrivate\)/)
  assert.match(isolatedShell, /updateNetwork\(\{ allowOut \}\)/)
  assert.match(isolatedShell, /network: \{ allowOut \}/)
})
