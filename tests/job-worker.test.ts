import assert from 'node:assert/strict'
import test from 'node:test'
import type { JobRecord } from '../lib/jobs/contracts'
import type { JobRepository } from '../lib/jobs/repository'
import { JobWorker, nextJobBackoff, type JobHandler } from '../lib/jobs/worker'
import { JobRuntimeError } from '../lib/jobs/errors'

function claimedJob(overrides: Partial<JobRecord> = {}): JobRecord {
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
    attempt: 1,
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

type RepositoryOverrides = Partial<{ [Key in keyof JobRepository]: JobRepository[Key] }>

function fakeRepository(overrides: RepositoryOverrides = {}): JobRepository {
  return {
    enqueue: async () => { throw new Error('not implemented') },
    claim: async () => ({ acquired: false, reason: 'empty', job: null }),
    renew: async () => ({ state: 'renewed', status: 'running', leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), cancelRequested: false }),
    retry: async () => ({ accepted: true, reason: null, status: 'queued', availableAt: new Date().toISOString(), eventSeq: 2, cancelRequested: false }),
    appendEvents: async () => ({ accepted: true, replayed: false, status: 'running', fromSeq: 1, toSeq: 1, cancelRequested: false }),
    checkpointWithAccounting: async input => ({
      accepted: true,
      replayed: false,
      reason: null,
      status: input.status ?? 'running',
      checkpointVersion: input.expectedCheckpointVersion + 1,
      cancelRequested: false,
    }),
    recordAccounting: async () => ({ accepted: true, replayed: false, status: 'running', cancelRequested: false }),
    resume: async () => ({
      accepted: false, replayed: false, reason: 'not_found',
      status: null, checkpointVersion: null, eventSeq: null,
    }),
    finalize: async input => ({ accepted: true, replayed: false, status: input.status, result: input.result ?? null, error: input.error ?? null, eventSeq: 2 }),
    cancel: async () => ({ accepted: true, replayed: false, status: 'cancelling', result: null, eventSeq: 2 }),
    ...overrides,
  }
}

function oneClaimRepository(input: {
  controller: AbortController
  handler?: JobHandler
  append?: JobRepository['appendEvents']
  checkpoint?: JobRepository['checkpointWithAccounting']
  finalize?: JobRepository['finalize']
}) {
  let claimCount = 0
  let handlerCount = 0
  let finalizationCount = 0
  const handler = input.handler ?? (async context => {
    handlerCount += 1
    await context.appendEvents([{ kind: 'text.delta', payload: { delta: 'done' } }])
    return { status: 'completed' as const, result: { ok: true } }
  })
  const repository = fakeRepository({
    claim: async () => {
      claimCount += 1
      return claimCount === 1
        ? { acquired: true, reason: 'claimed', job: claimedJob() }
        : { acquired: false, reason: 'empty', job: null }
    },
    ...(input.append ? { appendEvents: input.append } : {}),
    ...(input.checkpoint ? { checkpointWithAccounting: input.checkpoint } : {}),
    finalize: input.finalize ?? (async request => {
      finalizationCount += 1
      input.controller.abort()
      return { accepted: true, replayed: false, status: request.status, result: request.result ?? null, error: request.error ?? null, eventSeq: 3 }
    }),
  })
  return {
    repository,
    handlers: { 'chat.generation': handler },
    counts: () => ({ claimCount, handlerCount, finalizationCount }),
    countHandler: () => { handlerCount += 1 },
    countFinalization: () => { finalizationCount += 1 },
  }
}

test('worker permits only one local claim winner and fences every mutation', async () => {
  const controller = new AbortController()
  const fixture = oneClaimRepository({ controller })
  const worker = new JobWorker({
    repository: fixture.repository,
    workerId: 'worker-1',
    queues: ['chat'],
    handlers: fixture.handlers,
    concurrency: 2,
    backoffJitter: 0,
  })
  await worker.run(controller.signal)

  const counts = fixture.counts()
  assert.equal(counts.handlerCount, 1)
  assert.equal(counts.finalizationCount, 1)
  assert.ok(counts.claimCount >= 2)
})

test('worker checkpoints pending usage atomically and final-persist sends only the unacked delta', async () => {
  const controller = new AbortController()
  const checkpointEntries: Array<readonly import('../lib/jobs/repository').JobAccounting[]> = []
  let finalEntries: readonly import('../lib/jobs/repository').JobAccounting[] = []
  const fixture = oneClaimRepository({
    controller,
    handler: async context => {
      context.reportAccounting({
        idempotencyKey: 'model-usage', reason: 'provider',
        rawTokens: 10, weightedTokens: 10, costMicros: 10,
      })
      await context.checkpoint({
        phase: 'chat.model_round', checkpoint: { schemaVersion: 1 },
        progress: { totalTokens: 10 }, resumable: true,
      })
      context.reportAccounting({
        idempotencyKey: 'model-usage', reason: 'provider',
        rawTokens: 15, weightedTokens: 15, costMicros: 15,
      })
      return { status: 'completed', result: { ok: true } }
    },
    checkpoint: async input => {
      checkpointEntries.push(input.ledgerEntries)
      return {
        accepted: true, replayed: false, reason: null,
        status: input.status ?? 'running',
        checkpointVersion: input.expectedCheckpointVersion + 1,
        cancelRequested: false,
      }
    },
    finalize: async request => {
      controller.abort()
      return {
        accepted: true, replayed: false, status: request.status,
        result: request.result ?? null, error: request.error ?? null, eventSeq: 3,
      }
    },
  })
  fixture.repository.recordAccounting = async input => {
    finalEntries = input.ledgerEntries
    return { accepted: true, replayed: false, status: 'running', cancelRequested: false }
  }

  await new JobWorker({
    repository: fixture.repository,
    workerId: 'worker-1',
    queues: ['chat'],
    handlers: fixture.handlers,
    sleep: async (_milliseconds, signal) => {
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
    },
  }).run(controller.signal)

  assert.equal(checkpointEntries.length, 1)
  assert.equal(checkpointEntries[0]?.find(entry => entry.reason === 'provider')?.rawTokens, 10)
  assert.equal(finalEntries.find(entry => entry.reason === 'provider')?.rawTokens, 5)
  assert.equal(finalEntries.some(entry => entry.reason === 'provider' && entry.rawTokens === 15), false)
})

test('handler usage flush is fenced and durable before the handler can return', async () => {
  const controller = new AbortController()
  const order: string[] = []
  const fixture = oneClaimRepository({
    controller,
    handler: async context => {
      context.reportAccounting({
        idempotencyKey: 'model-usage', reason: 'provider',
        rawTokens: 9, weightedTokens: 9, costMicros: 9,
      })
      await context.flushAccounting()
      order.push('handler-return')
      return { status: 'completed', result: { ok: true } }
    },
    finalize: async request => {
      order.push('finalize')
      controller.abort()
      return {
        accepted: true, replayed: false, status: request.status,
        result: request.result ?? null, error: request.error ?? null, eventSeq: 3,
      }
    },
  })
  fixture.repository.recordAccounting = async input => {
    const provider = input.ledgerEntries.find(entry => entry.reason === 'provider')
    if (provider) {
      assert.equal(provider.rawTokens, 9)
      order.push('accounting-durable')
    } else {
      assert.equal(input.ledgerEntries.every(entry => entry.reason === 'job_resource_usage'), true)
    }
    return { accepted: true, replayed: false, status: 'running', cancelRequested: false }
  }

  await new JobWorker({
    repository: fixture.repository,
    workerId: 'worker-1',
    queues: ['chat'],
    handlers: fixture.handlers,
    sleep: async (_milliseconds, signal) => {
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
    },
  }).run(controller.signal)

  assert.deepEqual(order, ['accounting-durable', 'handler-return', 'finalize'])
})

test('worker reports the database-authoritative terminal after a completion race', async () => {
  const controller = new AbortController()
  const observed: string[] = []
  const fixture = oneClaimRepository({
    controller,
    handler: async () => ({ status: 'completed', result: { ok: true } }),
    finalize: async () => {
      controller.abort()
      return {
        accepted: false,
        replayed: true,
        status: 'cancelled',
        result: null,
        error: null,
        eventSeq: 3,
      }
    },
  })

  await new JobWorker({
    repository: fixture.repository,
    workerId: 'worker-1',
    queues: ['chat'],
    handlers: fixture.handlers,
    onFinalized: ({ status }) => { observed.push(status) },
    sleep: async (_milliseconds, signal) => {
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
    },
  }).run(controller.signal)

  assert.deepEqual(observed, ['cancelled'])
})

test('stale fencing rejection stops work and never attempts terminal CAS', async () => {
  const controller = new AbortController()
  let finalizeCount = 0
  const fixture = oneClaimRepository({
    controller,
    append: async () => {
      controller.abort()
      return { accepted: false, replayed: false, status: 'running', fromSeq: null, toSeq: null, cancelRequested: false }
    },
    finalize: async request => {
      finalizeCount += 1
      return { accepted: true, replayed: false, status: request.status, result: null, error: null, eventSeq: 3 }
    },
  })
  await new JobWorker({
    repository: fixture.repository,
    workerId: 'worker-1',
    queues: ['chat'],
    handlers: fixture.handlers,
  }).run(controller.signal)
  assert.equal(finalizeCount, 0)
})

test('authoritative cancellation signal finalizes cancelled with the same fence', async () => {
  const controller = new AbortController()
  let terminalStatus = ''
  const fixture = oneClaimRepository({
    controller,
    append: async () => ({ accepted: true, replayed: false, status: 'cancelling', fromSeq: 2, toSeq: 2, cancelRequested: true }),
    finalize: async request => {
      terminalStatus = request.status
      controller.abort()
      return { accepted: true, replayed: false, status: request.status, result: null, error: null, eventSeq: 3 }
    },
  })
  await new JobWorker({
    repository: fixture.repository,
    workerId: 'worker-1',
    queues: ['chat'],
    handlers: fixture.handlers,
  }).run(controller.signal)
  assert.equal(terminalStatus, 'cancelled')
})

test('graceful shutdown stops claiming then aborts an over-grace active handler', async () => {
  const shutdown = new AbortController()
  let started!: () => void
  const active = new Promise<void>(resolve => { started = resolve })
  let claimCount = 0
  let finalizeCount = 0
  let accountedTokens = -1
  const repository = fakeRepository({
    claim: async () => {
      claimCount += 1
      return claimCount === 1
        ? { acquired: true, reason: 'claimed', job: claimedJob() }
        : { acquired: false, reason: 'empty', job: null }
    },
    finalize: async request => {
      finalizeCount += 1
      return { accepted: true, replayed: false, status: request.status, result: null, error: null, eventSeq: 2 }
    },
    recordAccounting: async request => {
      accountedTokens = Number(request.ledgerEntries[0]?.rawTokens ?? 0)
      return { accepted: true, replayed: false, status: 'running', cancelRequested: false }
    },
  })
  const worker = new JobWorker({
    repository,
    workerId: 'worker-1',
    queues: ['chat'],
    handlers: {
      'chat.generation': async context => {
        context.reportAccounting({ idempotencyKey: 'model-usage', reason: 'provider', rawTokens: 5 })
        started()
        return new Promise<never>((_resolve, reject) => {
          context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true })
        })
      },
    },
    shutdownGraceMs: 0,
  })
  const running = worker.run(shutdown.signal)
  await active
  shutdown.abort()
  await running
  assert.equal(claimCount, 1)
  assert.equal(finalizeCount, 0)
  assert.equal(accountedTokens, 5)
})

test('renewal outage fails closed at the existing lease deadline', async () => {
  const shutdown = new AbortController()
  let now = 0
  let renewCount = 0
  let finalizeCount = 0
  const repository = fakeRepository({
    claim: async () => ({
      acquired: true,
      reason: 'claimed',
      job: claimedJob({ lease: { owner: 'worker-1', version: 9, expiresAt: new Date(250).toISOString() } }),
    }),
    renew: async () => {
      renewCount += 1
      return { state: 'unavailable', status: null, leaseExpiresAt: null, cancelRequested: false }
    },
    finalize: async request => {
      finalizeCount += 1
      return { accepted: true, replayed: false, status: request.status, result: null, error: null, eventSeq: 2 }
    },
  })
  const worker = new JobWorker({
    repository,
    workerId: 'worker-1',
    queues: ['chat'],
    handlers: {
      'chat.generation': async context => new Promise<never>((_resolve, reject) => {
        context.signal.addEventListener('abort', () => {
          shutdown.abort()
          reject(context.signal.reason)
        }, { once: true })
      }),
    },
    now: () => now,
    renewIntervalMs: 100,
    sleep: async (milliseconds, signal) => {
      if (signal.aborted) throw signal.reason
      now += milliseconds
      await Promise.resolve()
    },
  })
  await worker.run(shutdown.signal)
  assert.equal(renewCount, 2)
  assert.equal(finalizeCount, 0)
})

test('retryable provider failures are delay-queued without a false terminal state', async () => {
  const shutdown = new AbortController()
  let claims = 0
  let retries = 0
  let finalizations = 0
  const observedTerminals: string[] = []
  const repository = fakeRepository({
    claim: async () => {
      claims += 1
      return claims === 1
        ? { acquired: true, reason: 'claimed', job: claimedJob() }
        : { acquired: false, reason: 'empty', job: null }
    },
    retry: async input => {
      retries += 1
      assert.equal(input.error.class, 'provider')
      assert.ok(input.delaySeconds >= 1)
      shutdown.abort()
      return {
        accepted: true,
        reason: null,
        status: 'queued',
        availableAt: new Date().toISOString(),
        eventSeq: 2,
        cancelRequested: false,
      }
    },
    finalize: async request => {
      finalizations += 1
      return { accepted: true, replayed: false, status: request.status, result: null, error: request.error ?? null, eventSeq: 2 }
    },
  })
  await new JobWorker({
    repository,
    workerId: 'worker-1',
    queues: ['chat'],
    handlers: {
      'chat.generation': async () => {
        throw new JobRuntimeError('JOB_DEPENDENCY_UNAVAILABLE', 'provider offline', { class: 'provider' })
      },
    },
    backoffJitter: 0,
    random: () => 0.5,
    onFinalized: ({ status }) => { observedTerminals.push(status) },
  }).run(shutdown.signal)
  assert.equal(retries, 1)
  assert.equal(finalizations, 0)
  assert.deepEqual(observedTerminals, [])
})

test('worker durably records failed-attempt usage before scheduling a retry', async () => {
  const shutdown = new AbortController()
  const order: string[] = []
  let claims = 0
  let recordedEntries: readonly import('../lib/jobs/repository').JobAccounting[] = []
  const repository = fakeRepository({
    claim: async () => {
      claims += 1
      return claims === 1
        ? { acquired: true, reason: 'claimed', job: claimedJob() }
        : { acquired: false, reason: 'empty', job: null }
    },
    recordAccounting: async input => {
      order.push('accounting')
      recordedEntries = input.ledgerEntries
      return { accepted: true, replayed: false, status: 'running', cancelRequested: false }
    },
    retry: async () => {
      order.push('retry')
      shutdown.abort()
      return {
        accepted: true, reason: null, status: 'queued',
        availableAt: new Date().toISOString(), eventSeq: 3, cancelRequested: false,
      }
    },
  })
  await new JobWorker({
    repository,
    workerId: 'worker-1',
    queues: ['chat'],
    handlers: {
      'chat.generation': async context => {
        context.reportAccounting({
          idempotencyKey: 'model-usage', reason: 'provider', rawTokens: 17,
        })
        throw new JobRuntimeError('JOB_DEPENDENCY_UNAVAILABLE', 'provider offline', { class: 'provider' })
      },
    },
    random: () => 0.5,
  }).run(shutdown.signal)
  assert.deepEqual(order, ['accounting', 'retry'])
  assert.equal(recordedEntries.length, 2)
  assert.equal(recordedEntries[0].rawTokens, 17)
  assert.match(recordedEntries[0].idempotencyKey, /:attempt:1:/)
  assert.equal(recordedEntries[1].reason, 'job_resource_usage')
})

test('accounting failure suppresses both retry and terminal transition', async () => {
  const shutdown = new AbortController()
  let claims = 0
  let retries = 0
  let finalizations = 0
  const repository = fakeRepository({
    claim: async () => {
      claims += 1
      if (claims === 1) return { acquired: true, reason: 'claimed', job: claimedJob() }
      shutdown.abort()
      return { acquired: false, reason: 'empty', job: null }
    },
    recordAccounting: async () => {
      throw new JobRuntimeError('JOB_DEPENDENCY_UNAVAILABLE', 'ledger unavailable')
    },
    retry: async () => {
      retries += 1
      return { accepted: true, reason: null, status: 'queued', availableAt: new Date().toISOString(), eventSeq: 2, cancelRequested: false }
    },
    finalize: async request => {
      finalizations += 1
      return { accepted: true, replayed: false, status: request.status, result: null, error: request.error ?? null, eventSeq: 2 }
    },
  })
  await new JobWorker({
    repository,
    workerId: 'worker-1',
    queues: ['chat'],
    handlers: {
      'chat.generation': async context => {
        context.reportAccounting({ idempotencyKey: 'usage', reason: 'provider', rawTokens: 3 })
        throw new JobRuntimeError('JOB_DEPENDENCY_UNAVAILABLE', 'provider offline', { class: 'provider' })
      },
    },
    idleBackoffMinimumMs: 1,
    idleBackoffMaximumMs: 1,
  }).run(shutdown.signal)
  assert.equal(retries, 0)
  assert.equal(finalizations, 0)
})

test('budget excess is a stable non-retry terminal failure after accounting', async () => {
  const shutdown = new AbortController()
  let claims = 0
  let retries = 0
  let terminalCode = ''
  let accounted = false
  const repository = fakeRepository({
    claim: async () => {
      claims += 1
      return claims === 1
        ? { acquired: true, reason: 'claimed', job: claimedJob({ budget: { tokenLimit: 5 } }) }
        : { acquired: false, reason: 'empty', job: null }
    },
    recordAccounting: async () => {
      accounted = true
      return { accepted: true, replayed: false, status: 'running', cancelRequested: false }
    },
    retry: async () => {
      retries += 1
      return { accepted: true, reason: null, status: 'queued', availableAt: new Date().toISOString(), eventSeq: 2, cancelRequested: false }
    },
    finalize: async request => {
      terminalCode = request.error?.code ?? ''
      shutdown.abort()
      return { accepted: true, replayed: false, status: request.status, result: null, error: request.error ?? null, eventSeq: 3 }
    },
  })
  await new JobWorker({
    repository,
    workerId: 'worker-1',
    queues: ['chat'],
    handlers: {
      'chat.generation': async context => {
        context.reportAccounting({ idempotencyKey: 'usage', reason: 'provider', rawTokens: 6 })
        return { status: 'completed' }
      },
    },
  }).run(shutdown.signal)
  assert.equal(accounted, true)
  assert.equal(retries, 0)
  assert.equal(terminalCode, 'JOB_BUDGET_EXCEEDED')
})

test('an unsafe retry is terminally poisoned with a stable error code', async () => {
  const shutdown = new AbortController()
  let claims = 0
  let terminalCode = ''
  let poisonKind = ''
  const observedTerminals: string[] = []
  const repository = fakeRepository({
    claim: async () => {
      claims += 1
      return claims === 1
        ? { acquired: true, reason: 'claimed', job: claimedJob() }
        : { acquired: false, reason: 'empty', job: null }
    },
    retry: async () => ({
      accepted: false,
      reason: 'unsafe_effect',
      status: 'running',
      availableAt: null,
      eventSeq: 2,
      cancelRequested: false,
    }),
    finalize: async request => {
      terminalCode = request.error?.code ?? ''
      poisonKind = request.outbox?.[0]?.kind ?? ''
      shutdown.abort()
      return { accepted: true, replayed: false, status: request.status, result: null, error: request.error ?? null, eventSeq: 3 }
    },
  })
  await new JobWorker({
    repository,
    workerId: 'worker-1',
    queues: ['chat'],
    handlers: {
      'chat.generation': async () => {
        throw new JobRuntimeError('JOB_DEPENDENCY_UNAVAILABLE', 'provider offline', { class: 'provider' })
      },
    },
    onFinalized: ({ status }) => { observedTerminals.push(status) },
  }).run(shutdown.signal)
  assert.equal(terminalCode, 'JOB_RETRY_UNSAFE')
  assert.equal(poisonKind, 'jobs.poison')
  assert.deepEqual(observedTerminals, ['failed'])
})

test('backoff grows to its cap and applies bounded jitter', () => {
  assert.deepEqual(nextJobBackoff(100, 250, 0, () => 0), { waitMs: 100, nextMs: 200 })
  assert.deepEqual(nextJobBackoff(200, 250, 0.5, () => 1), { waitMs: 250, nextMs: 250 })
})
