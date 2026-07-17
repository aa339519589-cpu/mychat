import assert from 'node:assert/strict'
import test from 'node:test'
import { JobRuntimeError } from '../lib/jobs/errors'
import type {
  JobOutboxMessage,
  JobOutboxRepository,
} from '../lib/jobs/outbox-contracts'
import { JobOutboxDispatcher } from '../lib/jobs/outbox-dispatcher'

function message(overrides: Partial<JobOutboxMessage> = {}): JobOutboxMessage {
  return {
    id: '91000000-0000-4000-8000-000000000001',
    jobId: '91000000-0000-4000-8000-000000000002',
    principalId: '91000000-0000-4000-8000-000000000003',
    topic: 'assets.cleanup',
    payload: { jobId: '91000000-0000-4000-8000-000000000002' },
    attempt: 1,
    maxAttempts: 10,
    lockVersion: 4,
    lockExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

type Calls = {
  renewed: number
  published: Array<{ outboxId: string; workerId: string; lockVersion: number }>
  failed: Array<{
    outboxId: string
    workerId: string
    lockVersion: number
    errorCode: string
    retrySeconds: number
  }>
  cleaned: number
  payloadCleaned: number
}

function repositoryFixture(input: {
  claimed?: JobOutboxMessage | null
  cleanupError?: Error
} = {}): { repository: JobOutboxRepository; calls: Calls } {
  const calls: Calls = { renewed: 0, published: [], failed: [], cleaned: 0, payloadCleaned: 0 }
  let claimed = false
  const repository: JobOutboxRepository = {
    claim: async () => {
      if (claimed || input.claimed === null) return { acquired: false, message: null }
      claimed = true
      return { acquired: true, message: input.claimed ?? message() }
    },
    renew: async () => { calls.renewed += 1 },
    publish: async request => { calls.published.push(request) },
    fail: async request => { calls.failed.push(request) },
    cleanupAssets: async () => {
      calls.cleaned += 1
      if (input.cleanupError) throw input.cleanupError
      return 2
    },
    cleanupPayload: async () => {
      calls.payloadCleaned += 1
      return true
    },
  }
  return { repository, calls }
}

function abortableSleep(_milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason)
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
}

test('asset cleanup publishes only after the storage/database cleanup converges', async () => {
  const fixture = repositoryFixture()
  const dispatcher = new JobOutboxDispatcher({
    repository: fixture.repository,
    workerId: 'outbox-worker',
    sleep: abortableSleep,
  })
  assert.equal(await dispatcher.runOnce(), true)
  assert.equal(fixture.calls.cleaned, 1)
  assert.deepEqual(fixture.calls.published, [{
    outboxId: message().id,
    workerId: 'outbox-worker',
    lockVersion: 4,
  }])
  assert.deepEqual(fixture.calls.failed, [])
})

test('failed delivery is delay-queued with the same fencing generation', async () => {
  const fixture = repositoryFixture({
    cleanupError: new JobRuntimeError('JOB_DEPENDENCY_UNAVAILABLE', 'storage unavailable'),
  })
  const dispatcher = new JobOutboxDispatcher({
    repository: fixture.repository,
    workerId: 'outbox-worker',
    sleep: abortableSleep,
  })
  assert.equal(await dispatcher.runOnce(), true)
  assert.deepEqual(fixture.calls.published, [])
  assert.deepEqual(fixture.calls.failed, [{
    outboxId: message().id,
    workerId: 'outbox-worker',
    lockVersion: 4,
    errorCode: 'JOB_DEPENDENCY_UNAVAILABLE',
    retrySeconds: 5,
  }])
})

test('payload cleanup publishes only after its fenced object deletion', async () => {
  const payloadCleanup = message({ topic: 'payloads.cleanup' })
  const fixture = repositoryFixture({ claimed: payloadCleanup })
  const dispatcher = new JobOutboxDispatcher({
    repository: fixture.repository,
    workerId: 'outbox-worker',
    sleep: abortableSleep,
  })
  assert.equal(await dispatcher.runOnce(), true)
  assert.equal(fixture.calls.payloadCleaned, 1)
  assert.equal(fixture.calls.cleaned, 0)
  assert.equal(fixture.calls.published.length, 1)
})

test('a non-deliverable lifecycle topic is never acknowledged as published', async () => {
  const lifecycle = message({ topic: 'jobs.poison', attempt: 3, lockVersion: 9 })
  let claimedTopics: readonly string[] = []
  const fixture = repositoryFixture({ claimed: null })
  const repository = {
    ...fixture.repository,
    claim: async (input: Parameters<JobOutboxRepository['claim']>[0]) => {
      claimedTopics = input.topics
      return { acquired: false, message: null } as const
    },
  }
  const dispatcher = new JobOutboxDispatcher({
    repository,
    workerId: 'outbox-worker',
    sleep: abortableSleep,
  })
  assert.equal(await dispatcher.runOnce(), false)
  assert.deepEqual(claimedTopics, ['assets.cleanup', 'payloads.cleanup'])
  assert.equal(claimedTopics.includes(lifecycle.topic), false)
  assert.deepEqual(fixture.calls.published, [])
})

test('empty outbox performs no delivery mutation', async () => {
  const fixture = repositoryFixture({ claimed: null })
  const dispatcher = new JobOutboxDispatcher({
    repository: fixture.repository,
    workerId: 'outbox-worker',
    sleep: abortableSleep,
  })
  assert.equal(await dispatcher.runOnce(), false)
  assert.deepEqual(fixture.calls.published, [])
  assert.deepEqual(fixture.calls.failed, [])
})
