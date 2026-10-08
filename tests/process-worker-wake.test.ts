import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { parseProcessJobWakeMessage } from '../lib/jobs/process-worker-wake'

function message(overrides: Record<string, unknown> = {}) {
  return {
    type: 'mychat.job.wake.v1',
    queue: 'chat',
    jobId: randomUUID(),
    publishedAt: Date.now(),
    ...overrides,
  }
}

test('private process wake accepts only scoped durable Job notifications', () => {
  assert.equal(parseProcessJobWakeMessage(message())?.queue, 'chat')
  assert.equal(parseProcessJobWakeMessage(message({ type: 'untrusted' })), null)
  assert.equal(parseProcessJobWakeMessage(message({ queue: '../chat' })), null)
  assert.equal(parseProcessJobWakeMessage(message({ jobId: '../job' })), null)
  assert.equal(parseProcessJobWakeMessage(message({ publishedAt: -1 })), null)
})
