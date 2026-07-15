import assert from 'node:assert/strict'
import test from 'node:test'
import { JobBudgetController } from '../lib/jobs/budget'
import type { JobRecord } from '../lib/jobs/contracts'
import { JobRuntimeError } from '../lib/jobs/errors'

function job(overrides: Partial<JobRecord> = {}): JobRecord {
  const now = new Date().toISOString()
  return {
    id: '00000000-0000-4000-8000-000000000001',
    type: 'chat.generation',
    queue: 'chat',
    principal: { id: '00000000-0000-4000-8000-000000000002', authClass: 'registered' },
    subject: {},
    inputHash: '0123456789abcdef',
    input: {},
    status: 'leased',
    attempt: 2,
    maxAttempts: 3,
    priority: 0,
    availableAt: now,
    budget: {},
    usage: { wallTimeMs: 0, rawTokens: 0, weightedTokens: 0, costMicros: 0, sandboxTimeMs: 0, toolCalls: 0 },
    checkpoint: null,
    result: null,
    error: null,
    lease: { owner: 'worker-1', version: 4, expiresAt: new Date(Date.now() + 60_000).toISOString() },
    cancelRequestedAt: null,
    createdAt: now,
    updatedAt: now,
    terminalAt: null,
    ...overrides,
  }
}

function budget(overrides: Partial<JobRecord> = {}) {
  let now = 1_000
  let aborted: JobRuntimeError | null = null
  const controller = new JobBudgetController(job(overrides), () => now, error => { aborted = error })
  return { controller, advance: (milliseconds: number) => { now += milliseconds }, aborted: () => aborted }
}

test('job budget applies durable usage from prior attempts and emits a stable error', () => {
  const fixture = budget({
    budget: { tokenLimit: 100 },
    usage: { wallTimeMs: 0, rawTokens: 90, weightedTokens: 90, costMicros: 0, sandboxTimeMs: 0, toolCalls: 0 },
  })
  assert.throws(() => fixture.controller.reportAccounting({
    idempotencyKey: 'model-usage',
    reason: 'platform_model_usage',
    rawTokens: 11,
  }), (error: unknown) => {
    assert.ok(error instanceof JobRuntimeError)
    assert.equal(error.code, 'JOB_BUDGET_EXCEEDED')
    assert.equal(error.retryable, false)
    assert.equal(error.details.dimension, 'tokenLimit')
    return true
  })
  assert.equal(fixture.aborted()?.code, 'JOB_BUDGET_EXCEEDED')
})

test('tool, sandbox, cost, and wall dimensions share one fail-closed controller', () => {
  const tools = budget({ budget: { toolCallLimit: 1 } })
  tools.controller.consumeToolCall()
  assert.throws(() => tools.controller.consumeToolCall(), /toolCallLimit budget was exceeded/)

  const sandbox = budget({ budget: { sandboxTimeMs: 50 } })
  sandbox.controller.reportSandboxTime(50)
  assert.equal(sandbox.controller.remainingSandboxTimeMs(), 0)
  assert.throws(() => sandbox.controller.reportSandboxTime(1), /sandboxTimeMs budget was exceeded/)

  const cost = budget({ budget: { costMicros: 10 } })
  assert.throws(() => cost.controller.reportAccounting({
    idempotencyKey: 'cost', reason: 'provider', costMicros: 11,
  }), /costMicros budget was exceeded/)

  const wall = budget({ budget: { wallTimeMs: 100 } })
  wall.advance(101)
  assert.throws(() => wall.controller.assertWithinLimits(), /wallTimeMs budget was exceeded/)
})

test('accounting converts cumulative reports to immutable deltas and advances only after ack', () => {
  const fixture = budget()
  fixture.controller.reportAccounting({
    idempotencyKey: 'model-usage', reason: 'provider', rawTokens: 10,
    weightedTokens: 12, costMicros: 7, metadata: { modelClass: 'chat' },
  })
  fixture.controller.reportAccounting({
    idempotencyKey: 'model-usage', reason: 'provider', rawTokens: 15,
    weightedTokens: 18, costMicros: 9, metadata: { modelClass: 'chat' },
  })
  fixture.controller.consumeToolCall(2)
  fixture.advance(25)
  const entries = fixture.controller.pendingLedgerEntries(true)
  assert.equal(entries.length, 2)
  assert.match(entries[0].idempotencyKey, /^00000000-0000-4000-8000-000000000001:attempt:2:[0-9a-f]{64}$/)
  assert.equal(entries[0].rawTokens, 15)
  assert.equal(entries[0].weightedTokens, 18)
  assert.equal(entries[0].metadata?.attempt, 2)
  assert.equal(entries[0].metadata?.cumulativeRawTokens, 15)
  assert.deepEqual(entries[1].metadata, {
    wallTimeMs: 25,
    sandboxTimeMs: 0,
    toolCalls: 2,
    attempt: 2,
    accountingKey: 'resource-usage',
    costMicros: 0,
    cumulativeWallTimeMs: 25,
    cumulativeSandboxTimeMs: 0,
    cumulativeToolCalls: 2,
  })
  assert.strictEqual(fixture.controller.pendingLedgerEntries(), entries)

  fixture.controller.reportAccounting({
    idempotencyKey: 'model-usage', reason: 'provider', rawTokens: 20,
    weightedTokens: 24, costMicros: 12, metadata: { modelClass: 'chat' },
  })
  assert.strictEqual(fixture.controller.pendingLedgerEntries(), entries)
  fixture.controller.acknowledgeLedgerEntries(entries)

  fixture.advance(10)
  const next = fixture.controller.pendingLedgerEntries()
  assert.equal(next.length, 2)
  assert.equal(next[0].rawTokens, 5)
  assert.equal(next[0].weightedTokens, 6)
  assert.equal(next[0].costEstimate, 0.000003)
  assert.equal(next[0].metadata?.cumulativeRawTokens, 20)
  assert.deepEqual(next[1].metadata, {
    wallTimeMs: 10,
    sandboxTimeMs: 0,
    toolCalls: 0,
    attempt: 2,
    accountingKey: 'resource-usage',
    costMicros: 0,
    cumulativeWallTimeMs: 35,
    cumulativeSandboxTimeMs: 0,
    cumulativeToolCalls: 2,
  })
  assert.notEqual(next[0].idempotencyKey, entries[0].idempotencyKey)
  fixture.controller.acknowledgeLedgerEntries(next)
  assert.deepEqual(fixture.controller.pendingLedgerEntries(), [])
})

test('accounting never acknowledges a different or failed pending batch', () => {
  const fixture = budget()
  fixture.controller.reportAccounting({
    idempotencyKey: 'model-usage', reason: 'provider', rawTokens: 7,
  })
  const pending = fixture.controller.pendingLedgerEntries()
  assert.throws(
    () => fixture.controller.acknowledgeLedgerEntries([...pending]),
    /does not match the pending batch/,
  )
  assert.strictEqual(fixture.controller.pendingLedgerEntries(), pending)
  fixture.controller.acknowledgeLedgerEntries(pending)
  assert.deepEqual(fixture.controller.pendingLedgerEntries(), [])
})
