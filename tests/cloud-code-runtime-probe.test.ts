import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import vm from 'node:vm'
import { checkCommand } from '../lib/agent/command-security'

const source = readFileSync(new URL('../scripts/probe-cloud-code-workspace.mjs', import.meta.url), 'utf8')

test('acceptance fixture is real multiline JavaScript with a reproducible failing and passing test', () => {
  const literal = source.match(/const content = (`[^`]+`)/)?.[1]
  assert.ok(literal)
  const fixture = vm.runInNewContext(literal) as string
  assert.equal(fixture.includes('\\n'), false)
  assert.equal(fixture.split('\n').length, 5)
  const run = (input: string) => spawnSync(process.execPath, ['--input-type=module'], { input, encoding: 'utf8' })
  assert.notEqual(run(fixture).status, 0)
  const fixed = run(fixture.replace('a-b', 'a+b'))
  assert.equal(fixed.status, 0)
  assert.match(fixed.stdout, /CLOUD_ACCEPTANCE_NODE_OK/)
})

test('acceptance replay parses actual durable SSE seq/kind/payload and ignores heartbeats', () => {
  const body = source.match(/function parseAcceptanceFrame\(frame\) \{[\s\S]*?\n\}/)?.[0]
  assert.ok(body)
  const parse = vm.runInNewContext(`(${body})`) as (frame: string) => { seq: number; kind: string; payload: { toolName: string } } | null
  const frame = 'id: 7\r\nevent: job-event\r\ndata: {"seq":7,"kind":"tool.requested","payload":{"toolName":"read_file"}}'
  const event = parse(frame)
  assert.equal(event?.seq, 7)
  assert.equal(event?.kind, 'tool.requested')
  assert.equal(event?.payload.toolName, 'read_file')
  assert.equal(parse(': heartbeat'), null)
})

test('node repository script command allows only one relative script without flags or escaping', () => {
  assert.equal(checkCommand('node diagnostics/cloud-code/123-abc/fixture.mjs').allowed, true)
  for (const command of ['node -e x', 'node -p x', 'node --import x', 'node /tmp/x.mjs',
    'node ../x.mjs', 'node x.mjs extra', 'node x.mjs; echo ok']) assert.equal(checkCommand(command).allowed, false)
})
