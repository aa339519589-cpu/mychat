import assert from 'node:assert/strict'
import test from 'node:test'
import type { SupabaseClient } from '@supabase/supabase-js'
import { SupabaseJobRepository } from '../lib/jobs/supabase-repository'

const timestamp = '2026-07-13T12:00:00.000Z'

function databaseJob(overrides: Record<string, unknown> = {}) {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    type: 'chat.generation',
    queue: 'chat',
    principalId: '00000000-0000-4000-8000-000000000002',
    authClass: 'registered',
    subject: { conversationId: 'conversation-id' },
    inputHash: '0123456789abcdef',
    payload: { message: 'hello' },
    status: 'leased',
    attempt: 1,
    maxAttempts: 3,
    priority: 0,
    availableAt: timestamp,
    budget: {},
    checkpoint: null,
    result: null,
    errorClass: null,
    errorCode: null,
    leaseOwner: 'worker-1',
    leaseVersion: 7,
    leaseExpiresAt: '2026-07-13T12:01:00.000Z',
    cancelRequestedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    terminalAt: null,
    ...overrides,
  }
}

function repositoryWith(
  rpc: (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: null | { code: string } }>,
  rpcTimeoutMs = 100,
) {
  const client = { rpc } as unknown as SupabaseClient
  return new SupabaseJobRepository({ createAdminClient: () => client, rpcTimeoutMs })
}

test('Supabase repository enqueues bounded JSON and maps the canonical job contract', async () => {
  let calledName = ''
  let calledArgs: Record<string, unknown> = {}
  const repository = repositoryWith(async (name, args) => {
    calledName = name
    calledArgs = args
    return { data: { enqueued: true, replayed: false, job: databaseJob({ status: 'queued', leaseOwner: null, leaseVersion: 0, leaseExpiresAt: null }) }, error: null }
  })
  const result = await repository.enqueue({
    jobId: '00000000-0000-4000-8000-000000000001',
    type: 'chat.generation',
    queue: 'chat',
    principal: { id: '00000000-0000-4000-8000-000000000002', authClass: 'registered' },
    subject: { conversationId: 'conversation-id' },
    idempotencyKey: 'intent-1',
    inputHash: '0123456789abcdef',
    input: { message: 'hello' },
  })

  assert.equal(calledName, 'enqueue_job')
  assert.equal('input_available_at' in calledArgs, false)
  assert.equal(calledArgs.input_payload && (calledArgs.input_payload as { message: string }).message, 'hello')
  assert.equal(result.created, true)
  assert.equal(result.job.principal.id, '00000000-0000-4000-8000-000000000002')
  assert.equal(result.job.lease, null)
})

test('Supabase repository preserves claim fencing and emits schema-versioned batches', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  const repository = repositoryWith(async (name, args) => {
    calls.push({ name, args })
    if (name === 'claim_next_job') return { data: { acquired: true, job: databaseJob() }, error: null }
    return {
      data: { appended: true, fromSeq: 8, toSeq: 8, status: 'running', cancelRequested: false },
      error: null,
    }
  })
  const claim = await repository.claim({ workerId: 'worker-1', queues: ['chat'], leaseSeconds: 45 })
  assert.equal(claim.job?.lease?.version, 7)
  const appended = await repository.appendEvents({
    jobId: databaseJob().id as string,
    workerId: 'worker-1',
    leaseVersion: 7,
    events: [{ kind: 'text.delta', payload: { delta: 'hi' } }],
  })
  assert.deepEqual(appended, {
    accepted: true,
    replayed: false,
    status: 'running',
    fromSeq: 8,
    toSeq: 8,
    cancelRequested: false,
  })
  assert.deepEqual(calls[1].args.input_events, [{ schemaVersion: 1, kind: 'text.delta', payload: { delta: 'hi' } }])
})

test('Supabase repository maps renew outage, terminal CAS, and cancellation', async () => {
  let mode = 'renew-error'
  const repository = repositoryWith(async (name, args) => {
    if (mode === 'renew-error') return { data: null, error: { code: '08006' } }
    if (name === 'finalize_job') {
      assert.equal(args.input_error_code, null)
      assert.deepEqual(args.input_ledger_entries, [{ reason: 'completion' }])
      return { data: { finalized: false, replayed: true, status: 'completed', result: { ok: true }, eventSeq: 9 }, error: null }
    }
    return { data: { accepted: true, replayed: false, status: 'cancelling', result: null, eventSeq: 10 }, error: null }
  })
  const renewed = await repository.renew({
    jobId: databaseJob().id as string,
    workerId: 'worker-1',
    leaseVersion: 7,
    leaseSeconds: 45,
  })
  assert.equal(renewed.state, 'unavailable')
  mode = 'success'
  const finalized = await repository.finalize({
    jobId: databaseJob().id as string,
    workerId: 'worker-1',
    leaseVersion: 7,
    status: 'completed',
    result: { ok: true },
    ledgerEntries: [{ reason: 'completion' }],
  })
  assert.equal(finalized.replayed, true)
  assert.equal(finalized.accepted, false)
  const cancelled = await repository.cancel({
    jobId: databaseJob().id as string,
    principalId: '00000000-0000-4000-8000-000000000002',
    reason: 'user_request',
  })
  assert.equal(cancelled.status, 'cancelling')
})
