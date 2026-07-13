import assert from 'node:assert/strict'
import test from 'node:test'

import { log } from '../lib/logger'

test('logger emits structured JSON and redacts credential-shaped fields', t => {
  const original = console.log
  let output = ''
  console.log = value => { output = String(value) }
  t.after(() => { console.log = original })

  log.info('test', 'structured', {
    requestId: 'request-1',
    apiKey: 'top-secret',
    nested: { authorization: 'Bearer secret', count: 2 },
  })

  const parsed = JSON.parse(output)
  assert.equal(parsed.level, 'info')
  assert.equal(parsed.service, 'mychat')
  assert.equal(parsed.tag, 'test')
  assert.equal(parsed.message, 'structured')
  assert.equal(parsed.data.requestId, 'request-1')
  assert.equal(parsed.data.apiKey, '[redacted]')
  assert.equal(parsed.data.nested.authorization, '[redacted]')
  assert.equal(parsed.data.nested.count, 2)
})

test('logger safely serializes errors and circular data', t => {
  const original = console.error
  let output = ''
  console.error = value => { output = String(value) }
  t.after(() => { console.error = original })

  const circular: Record<string, unknown> = {}
  circular.self = circular
  log.error('test', 'failed', { error: new Error('boom'), circular })

  const parsed = JSON.parse(output)
  assert.equal(parsed.data.error.name, 'Error')
  assert.equal(parsed.data.error.message, 'boom')
  assert.equal(parsed.data.circular.self, '[circular]')
})

test('logger redacts credentials embedded in strings and error messages', t => {
  const original = console.error
  let output = ''
  console.error = value => { output = String(value) }
  t.after(() => { console.error = original })

  log.error('test', 'request with Bearer abcdefghijklmnop failed', {
    body: 'api_key=sk-abcdefghijklmnop and token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature123',
    error: new Error('password=hunter2secret'),
  })

  assert.doesNotMatch(output, /abcdefghijklmnop|hunter2secret|eyJhbGci/)
  const parsed = JSON.parse(output)
  assert.equal(parsed.message, 'request with Bearer [redacted] failed')
  assert.match(parsed.data.body, /api_key=\[redacted\]/)
  assert.equal(parsed.data.error.message, 'password=[redacted]')
})
