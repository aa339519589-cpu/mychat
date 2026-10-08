import { Sandbox } from 'e2b'

const serviceId = process.env.RENDER_SERVICE_ID
const renderKey = process.env.RENDER_API_KEY
let sandbox
let stage = 'configuration'
try {
  if (!serviceId || !renderKey) throw new Error('Missing probe configuration')
  const response = await fetch(`https://api.render.com/v1/services/${serviceId}/env-vars/E2B_API_KEY`, {
    headers: { Authorization: `Bearer ${renderKey}` }, signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error('Sandbox credential unavailable')
  const configuration = await response.json()
  if (typeof configuration.value !== 'string' || !configuration.value) throw new Error('Missing sandbox credential')
  stage = 'create-sandbox'
  sandbox = await Sandbox.create({ apiKey: configuration.value, timeoutMs: 120_000,
    network: { allowOut: [] }, metadata: { purpose: 'mychat-controlled-code-verification' } })
  stage = 'write-controlled-fixtures'
  await sandbox.commands.run('mkdir -p /home/user/workspace', { timeoutMs: 10_000 })
  await sandbox.files.write([
    { path: '/home/user/workspace/probe.mjs', data: 'import assert from "node:assert/strict"; assert.equal([1,2,3].reduce((a,b)=>a+b,0),6); console.log("NODE_OK");' },
    { path: '/home/user/workspace/probe_test.py', data: 'import unittest\nclass CloudCheck(unittest.TestCase):\n def test_sum(self): self.assertEqual(sum([1,2,3]),6)\n' },
  ])
  stage = 'execute-cloud-tests'
  const execution = await sandbox.commands.run('cd /home/user/workspace && node probe.mjs && python3 -m unittest probe_test.py && git init -q && git status --short', { timeoutMs: 30_000 })
  if (execution.exitCode !== 0 || !execution.stdout.includes('NODE_OK') || !execution.stdout.includes('probe.mjs')) {
    throw new Error('Cloud command verification failed')
  }
  stage = 'read-cloud-file'
  const file = await sandbox.files.read('/home/user/workspace/probe.mjs')
  if (!file.includes('assert.equal')) throw new Error('Cloud file verification failed')
  console.log('CLOUD_CODE_PROBE ' + JSON.stringify({ cloudOnly: true, deniedNetworkEgress: true,
    nodeTest: true, pythonTest: true, gitStatus: true, fileWriteRead: true, ok: true }))
} catch (error) {
  console.error('CLOUD_CODE_PROBE ' + JSON.stringify({ stage, ok: false,
    errorType: error instanceof Error ? error.name : 'unknown' }))
  process.exitCode = 1
} finally {
  if (sandbox) await sandbox.kill().catch(() => undefined)
}
