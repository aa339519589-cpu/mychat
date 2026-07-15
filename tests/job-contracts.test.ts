import assert from 'node:assert/strict'
import test from 'node:test'
import {
  JOB_EVENT_SCHEMA_VERSION,
  assertEnqueueJobInput,
  assertJobEvents,
  isJsonValue,
  isTerminalJobStatus,
} from '../lib/jobs/contracts'
import { JobRuntimeError, normalizeJobError } from '../lib/jobs/errors'

test('job contracts expose the complete terminal state and versioned event protocol', () => {
  assert.equal(isTerminalJobStatus('completed'), true)
  assert.equal(isTerminalJobStatus('cancelled'), true)
  assert.equal(isTerminalJobStatus('running'), false)
  assert.equal(JOB_EVENT_SCHEMA_VERSION, 1)
  assert.doesNotThrow(() => assertJobEvents([{
    kind: 'text.delta',
    payload: { delta: 'hello' },
  }]))
  assert.throws(() => assertJobEvents([{ kind: 'terminal', payload: {} }]), TypeError)
  assert.throws(() => assertJobEvents([]), TypeError)
})

test('enqueue validation rejects unbounded or ambiguous identities', () => {
  const valid = {
    jobId: '00000000-0000-4000-8000-000000000001',
    type: 'chat.generation',
    queue: 'chat',
    principal: { id: '00000000-0000-4000-8000-000000000002', authClass: 'registered' as const },
    subject: { conversationId: 'conversation-id' },
    idempotencyKey: 'intent-1',
    inputHash: '0123456789abcdef',
    input: { message: 'hello' },
  }
  assert.doesNotThrow(() => assertEnqueueJobInput(valid))
  assert.throws(() => assertEnqueueJobInput({ ...valid, type: 'generation' }), TypeError)
  assert.throws(() => assertEnqueueJobInput({ ...valid, maxAttempts: 101 }), TypeError)
  assert.throws(() => assertEnqueueJobInput({ ...valid, budget: { tokenLimit: 1.5 } }), TypeError)
  assert.throws(() => assertEnqueueJobInput({
    ...valid,
    budget: { wallTimeMs: 1_000, sandboxTimeMs: 1_001 },
  }), TypeError)
  assert.doesNotThrow(() => assertEnqueueJobInput({
    ...valid,
    budget: { wallTimeMs: 1_000, tokenLimit: 10, toolCallLimit: 1 },
  }))
  assert.equal(isJsonValue({ nested: [1, true, null] }), true)
  assert.equal(isJsonValue({ invalid: Number.NaN }), false)
})

test('job errors preserve stable machine fields without leaking arbitrary causes', () => {
  const error = new JobRuntimeError('JOB_LEASE_STALE', 'Lease is stale', {
    details: { leaseVersion: 4 },
  })
  assert.deepEqual(error.toFailure(), {
    code: 'JOB_LEASE_STALE',
    message: 'Lease is stale',
    retryable: false,
    class: 'internal',
    details: { leaseVersion: 4 },
  })
  const normalized = normalizeJobError({ name: 'ProviderError', status: 503, secret: 'hidden' })
  assert.deepEqual(normalized.details, { name: 'ProviderError', status: 503 })
})
