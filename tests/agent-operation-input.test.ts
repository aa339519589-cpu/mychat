import assert from 'node:assert/strict'
import test from 'node:test'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { JobExecutionContext } from '../lib/jobs/worker'
import { sha256 } from '../lib/agent/confirmation-plan'
import { prepareAgentOperation } from '../lib/code-agent/operation-plan'
import { loadAgentOperation } from '../lib/jobs/handlers/agent-operation-input'

const userId = '87000000-0000-4000-8000-000000000001'
const taskId = '87000000-0000-4000-8000-000000000002'

async function prepared() {
  return prepareAgentOperation({} as SupabaseClient, userId, {
    repo: null,
    taskId,
    mode: 'direct_push',
    message: 'publish',
    actions: [{ kind: 'create_repo', name: 'safe-project', private: true }],
  })
}

function context(input: unknown): JobExecutionContext {
  return {
    job: {
      id: '87000000-0000-4000-8000-000000000003',
      principal: { id: userId, authClass: 'registered' },
      subject: { taskId },
      input,
    },
    fence: {
      jobId: '87000000-0000-4000-8000-000000000003',
      workerId: 'worker',
      leaseVersion: 1,
    },
  } as unknown as JobExecutionContext
}

function client(authority: Record<string, unknown>): SupabaseClient {
  return {
    rpc(name: string) {
      assert.equal(name, 'read_agent_operation_authority')
      return Promise.resolve({ data: authority, error: null })
    },
  } as unknown as SupabaseClient
}

function payloadFor(value: Awaited<ReturnType<typeof prepared>>) {
  return {
    ...value.operation,
    operationHash: value.operationHash,
    planHash: value.planHash,
  }
}

function authorityFor(value: Awaited<ReturnType<typeof prepared>>) {
  return {
    ok: true,
    planCanonical: value.planCanonical,
    planHash: value.planHash,
    snapshotId: null,
    snapshotDigest: null,
  }
}

test('agent operation input accepts a hash-bound initial repository plan', async () => {
  const value = await prepared()
  const loaded = await loadAgentOperation(context(payloadFor(value)), client(authorityFor(value)))
  assert.equal(loaded.kind, 'initial_repository')
  assert.equal(loaded.taskId, taskId)
  assert.equal(loaded.plan.workspaceStateSha256, value.operationHash)
  assert.equal(loaded.plan.payload.operationInputSha256, value.operationHash)
})

test('agent operation input rejects array-wrapped payloads before reading authority', async () => {
  const value = await prepared()
  let rpcCalled = false
  const database = {
    rpc() {
      rpcCalled = true
      return Promise.resolve({ data: null, error: null })
    },
  } as unknown as SupabaseClient
  await assert.rejects(
    loadAgentOperation(context([payloadFor(value)]), database),
    /Invalid operation payload/,
  )
  assert.equal(rpcCalled, false)
})

test('agent operation input rejects an array canonical plan even when its hash matches', async () => {
  const value = await prepared()
  const arrayCanonical = `[${value.planCanonical}]`
  const planHash = sha256(arrayCanonical)
  const payload = { ...payloadFor(value), planHash }
  await assert.rejects(loadAgentOperation(context(payload), client({
    ...authorityFor(value),
    planCanonical: arrayCanonical,
    planHash,
  })), /Operation does not match confirmed plan/)
})
