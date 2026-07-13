import assert from 'node:assert/strict'
import test from 'node:test'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  claimGenerationLease,
  finalizeGenerationLease,
  renewGenerationLease,
  requestGenerationCancellation,
} from '../lib/generation/lease'

function withAdmin(client: unknown) {
  return { createAdminClient: () => client as SupabaseClient }
}

test('claim maps the database fencing token and immutable task identity', async () => {
  let rpcName = ''
  let rpcArgs: Record<string, unknown> = {}
  const client = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcName = name
      rpcArgs = args
      return {
        data: {
          acquired: true,
          status: 'running',
          leaseVersion: 9,
          leaseExpiresAt: '2026-07-13T06:00:00.000Z',
          media: [],
        },
        error: null,
      }
    },
  }

  const result = await claimGenerationLease({
    userId: 'user-id',
    generationId: 'generation-id',
    conversationId: 'conversation-id',
    assistantMessageId: 'message-id',
    runnerId: 'runner-id',
  }, withAdmin(client))

  assert.equal(rpcName, 'claim_chat_generation')
  assert.deepEqual(rpcArgs, {
    input_generation_id: 'generation-id',
    input_user_id: 'user-id',
    input_conversation_id: 'conversation-id',
    input_assistant_message_id: 'message-id',
    input_runner_id: 'runner-id',
    lease_seconds: 45,
  })
  assert.deepEqual(result, {
    ok: true,
    acquired: true,
    status: 'running',
    lease: {
      runnerId: 'runner-id',
      version: 9,
      expiresAt: '2026-07-13T06:00:00.000Z',
    },
    media: [],
  })
})

test('claim preserves active and stale loser reasons', async () => {
  for (const [reason, status] of [
    ['active', 'running'],
    ['assistant_conflict', 'completed'],
    ['conversation_active', 'running'],
    ['stale', 'failed'],
  ] as const) {
    const client = {
      rpc: async () => ({ data: { acquired: false, reason, status, media: [] }, error: null }),
    }
    const result = await claimGenerationLease({
      userId: 'user-id',
      generationId: 'g',
      conversationId: 'c',
      assistantMessageId: 'm',
      runnerId: 'r',
    }, withAdmin(client))
    assert.deepEqual(result, { ok: true, acquired: false, status, reason, media: [] })
  }
})

test('renewal is fenced and fails closed when the RPC is unavailable', async () => {
  const renewed = await renewGenerationLease({
    userId: 'u', generationId: 'g', runnerId: 'r', leaseVersion: 3,
  }, withAdmin({ rpc: async () => ({ data: true, error: null }) }))
  const lost = await renewGenerationLease({
    userId: 'u', generationId: 'g', runnerId: 'r', leaseVersion: 2,
  }, withAdmin({ rpc: async () => ({ data: false, error: null }) }))
  const unavailable = await renewGenerationLease({
    userId: 'u', generationId: 'g', runnerId: 'r', leaseVersion: 1,
  }, withAdmin({ rpc: async () => ({ data: null, error: { code: '08006' } }) }))
  const timeoutStartedAt = Date.now()
  const timedOut = await renewGenerationLease({
    userId: 'u', generationId: 'g', runnerId: 'r', leaseVersion: 1, timeoutMs: 10,
  }, withAdmin({ rpc: () => new Promise(() => undefined) }))

  assert.equal(renewed, 'renewed')
  assert.equal(lost, 'lost')
  assert.equal(unavailable, 'unavailable')
  assert.equal(timedOut, 'unavailable')
  assert.ok(Date.now() - timeoutStartedAt < 250)
})

test('terminal CAS returns the authoritative cancellation snapshot', async () => {
  let args: Record<string, unknown> = {}
  const client = {
    rpc: async (_name: string, input: Record<string, unknown>) => {
      args = input
      return {
        data: {
          accepted: false,
          status: 'cancelled',
          content: 'db-content',
          thinking: 'db-thinking',
          sequence: 14,
          media: [],
        },
        error: null,
      }
    },
  }

  const result = await finalizeGenerationLease({
    userId: 'user-id',
    generationId: 'g',
    runnerId: 'runner-a',
    leaseVersion: 4,
    status: 'completed',
    content: 'local-content',
    thinking: '',
    sequence: 13,
  }, withAdmin(client))

  assert.equal(args.input_user_id, 'user-id')
  assert.equal(args.input_runner_id, 'runner-a')
  assert.equal(args.input_lease_version, 4)
  assert.equal(args.input_status, 'completed')
  assert.deepEqual(args.input_media, [])
  assert.deepEqual(result, {
    ok: true,
    accepted: false,
    status: 'cancelled',
    content: 'db-content',
    thinking: 'db-thinking',
    sequence: 14,
    media: [],
  })
})

test('cancellation uses the ownership-checked CAS RPC', async () => {
  let name = ''
  const client = {
    rpc: async (rpcName: string) => {
      name = rpcName
      return { data: { accepted: false, status: 'completed', sequence: 8, media: [] }, error: null }
    },
  }
  const result = await requestGenerationCancellation({
    userId: 'user-id',
    generationId: 'generation-id',
  }, withAdmin(client))

  assert.equal(name, 'cancel_chat_generation')
  assert.deepEqual(result, {
    ok: true,
    accepted: false,
    status: 'completed',
    sequence: 8,
    media: [],
  })
})

test('coordination fails closed without a service-role client', async () => {
  const claim = await claimGenerationLease({
    userId: 'u',
    generationId: 'g',
    conversationId: 'c',
    assistantMessageId: 'm',
    runnerId: 'r',
  }, { createAdminClient: () => null })
  const renewal = await renewGenerationLease({
    userId: 'u', generationId: 'g', runnerId: 'r', leaseVersion: 1,
  }, { createAdminClient: () => null })

  assert.deepEqual(claim, { ok: false, errorCode: 'admin_not_configured' })
  assert.equal(renewal, 'unavailable')
})
