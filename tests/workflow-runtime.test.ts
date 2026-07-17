import assert from 'node:assert/strict'
import test from 'node:test'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { EnqueueJobInput, JobRecord } from '../lib/jobs/contracts'
import type { JobRepository } from '../lib/jobs/repository'
import type { PublicJobEvent, PublicJobSnapshot } from '../lib/jobs/read-model'
import { PostgresWorkflowRuntime, type WorkflowStartCommand } from '../lib/workflows/runtime'

const EXECUTION_ID = '10000000-0000-4000-8000-000000000001'
const ACTOR_ID = '10000000-0000-4000-8000-000000000002'
const now = '2026-07-16T00:00:00.000Z'

function job(input: EnqueueJobInput): JobRecord {
  return {
    id: input.jobId,
    type: input.type,
    queue: input.queue,
    principal: input.principal,
    subject: input.subject,
    inputHash: input.inputHash,
    input: input.input,
    status: 'queued',
    attempt: 0,
    maxAttempts: input.maxAttempts ?? 3,
    priority: input.priority ?? 0,
    availableAt: input.availableAt ?? now,
    budget: input.budget ?? {},
    usage: { wallTimeMs: 0, rawTokens: 0, weightedTokens: 0, costMicros: 0, sandboxTimeMs: 0, toolCalls: 0 },
    checkpoint: null,
    result: null,
    error: null,
    lease: null,
    cancelRequestedAt: null,
    createdAt: now,
    updatedAt: now,
    terminalAt: null,
  }
}

function repository(overrides: Partial<JobRepository> = {}): JobRepository {
  return {
    enqueue: async input => ({ created: true, job: job(input) }),
    claim: async () => ({ acquired: false, reason: 'empty', job: null }),
    renew: async () => ({ state: 'lost', status: null, leaseExpiresAt: null, cancelRequested: false }),
    retry: async () => ({ accepted: false, reason: 'not_found', status: null, availableAt: null, eventSeq: null, cancelRequested: false }),
    appendEvents: async () => ({ accepted: false, replayed: false, status: null, fromSeq: null, toSeq: null, cancelRequested: false }),
    checkpointWithAccounting: async () => ({ accepted: false, replayed: false, reason: 'not_found', status: null, checkpointVersion: null, cancelRequested: false }),
    recordAccounting: async () => ({ accepted: false, replayed: false, status: null, cancelRequested: false }),
    resume: async () => ({ accepted: true, replayed: false, reason: null, status: 'queued', checkpointVersion: 3, eventSeq: 8 }),
    finalize: async () => ({ accepted: false, replayed: false, status: 'failed', result: null, error: null, eventSeq: null }),
    cancel: async () => ({ accepted: true, replayed: false, status: 'cancelling', result: null, eventSeq: 7 }),
    ...overrides,
  }
}

const command: WorkflowStartCommand = {
  executionId: EXECUTION_ID,
  workflowName: 'chat.title',
  taskQueue: 'title',
  actor: { id: ACTOR_ID, authClass: 'registered' },
  target: { conversationId: '20000000-0000-4000-8000-000000000001' },
  deduplicationKey: 'title:conversation:message',
  inputDigest: '0123456789abcdef',
  input: { schemaVersion: 1 },
  limits: { wallTimeMs: 60_000, tokenLimit: 8_192 },
  maxAttempts: 3,
}

test('Postgres workflow start maps the provider-neutral command exactly once', async () => {
  let captured: EnqueueJobInput | null = null
  const runtime = new PostgresWorkflowRuntime({
    repository: repository({
      enqueue: async input => {
        captured = input
        return { created: true, job: job(input) }
      },
    }),
    client: {} as SupabaseClient,
  })

  const result = await runtime.start(command)

  assert.deepEqual(captured, {
    jobId: command.executionId,
    type: command.workflowName,
    queue: command.taskQueue,
    principal: command.actor,
    subject: command.target,
    idempotencyKey: command.deduplicationKey,
    inputHash: command.inputDigest,
    input: command.input,
    budget: command.limits,
    priority: undefined,
    maxAttempts: 3,
    availableAt: undefined,
  })
  assert.deepEqual(result, {
    executionId: EXECUTION_ID,
    workflowName: 'chat.title',
    state: 'queued',
    created: true,
  })
})

test('Postgres workflow control operations preserve actor, signal, and read authority', async () => {
  let cancelInput: unknown
  let resumeInput: unknown
  const publicSnapshot: PublicJobSnapshot = {
    id: EXECUTION_ID,
    type: 'chat.title',
    queue: 'title',
    subject: command.target,
    status: 'awaiting_input',
    attempt: 1,
    maxAttempts: 3,
    priority: 0,
    availableAt: now,
    cancelRequestedAt: null,
    progress: {},
    result: null,
    errorClass: null,
    errorCode: null,
    eventSequence: 4,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    terminalAt: null,
  }
  const publicEvent: PublicJobEvent = {
    id: '30000000-0000-4000-8000-000000000001',
    jobId: EXECUTION_ID,
    seq: 4,
    kind: 'job.awaiting_input',
    schemaVersion: 1,
    payload: {},
    createdAt: now,
  }
  const runtime = new PostgresWorkflowRuntime({
    repository: repository({
      cancel: async input => {
        cancelInput = input
        return { accepted: true, replayed: false, status: 'cancelling', result: null, eventSeq: 5 }
      },
      resume: async input => {
        resumeInput = input
        return { accepted: true, replayed: false, reason: null, status: 'queued', checkpointVersion: 3, eventSeq: 6 }
      },
    }),
    client: {} as SupabaseClient,
    readJob: async () => ({ ok: true, value: publicSnapshot }),
    readEvents: async () => ({ ok: true, value: [publicEvent] }),
  })

  assert.deepEqual(await runtime.cancel({ executionId: EXECUTION_ID, actorId: ACTOR_ID, reason: 'user' }), {
    accepted: true, replayed: false, state: 'cancelling',
  })
  assert.deepEqual(cancelInput, { jobId: EXECUTION_ID, principalId: ACTOR_ID, reason: 'user' })
  assert.deepEqual(await runtime.signal({
    executionId: EXECUTION_ID,
    actorId: ACTOR_ID,
    signalName: 'resume',
    signalId: 'resume-command-1',
    expectedVersion: 2,
    payload: { approved: true },
  }), { accepted: true, replayed: false, state: 'queued', reason: null })
  assert.deepEqual(resumeInput, {
    jobId: EXECUTION_ID,
    principalId: ACTOR_ID,
    expectedCheckpointVersion: 2,
    idempotencyKey: 'resume-command-1',
    resumeInput: { approved: true },
  })
  await assert.rejects(() => runtime.signal({
    executionId: EXECUTION_ID,
    actorId: ACTOR_ID,
    signalName: 'unknown',
    signalId: 'unknown-command-1',
    expectedVersion: 2,
    payload: {},
  }), /Unsupported workflow signal/)

  const status = await runtime.status({ executionId: EXECUTION_ID, actorId: ACTOR_ID })
  assert.equal(status.ok && status.value.executionId, EXECUTION_ID)
  assert.equal(status.ok && status.value.state, 'awaiting_input')
  const events = await runtime.events({ executionId: EXECUTION_ID, actorId: ACTOR_ID, afterSequence: 0 })
  assert.equal(events.ok && events.value[0]?.executionId, EXECUTION_ID)
})
