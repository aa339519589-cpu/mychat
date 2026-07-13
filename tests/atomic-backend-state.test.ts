import assert from 'node:assert/strict'
import test from 'node:test'
import type { SupabaseClient } from '@supabase/supabase-js'
import { mergeTaskMeta } from '../lib/agent/meta'
import { saveAgentRunState } from '../lib/agent/run-state'
import { addQuotaUsage } from '../lib/quota'

function client(value: unknown): SupabaseClient {
  return value as SupabaseClient
}

test('task metadata accepts only the atomic merge result', async () => {
  let tableReads = 0
  const supabase = client({
    rpc: async (name: string) => {
      assert.equal(name, 'merge_agent_task_meta')
      return { data: { deployPages: true }, error: null }
    },
    from: () => { tableReads += 1; throw new Error('non-atomic fallback used') },
  })

  assert.deepEqual(await mergeTaskMeta(supabase, 'user', 'task', { deployPages: true }), {
    deployPages: true,
  })
  assert.equal(tableReads, 0)
})

test('task metadata fails closed when the atomic RPC is unavailable', async () => {
  let tableReads = 0
  const supabase = client({
    rpc: async () => ({ data: null, error: { code: 'PGRST503' } }),
    from: () => { tableReads += 1; throw new Error('non-atomic fallback used') },
  })

  assert.equal(await mergeTaskMeta(supabase, 'user', 'task', { status: 'ready' }), null)
  assert.equal(tableReads, 0)
})

test('agent run checkpoints use the atomic run-state RPC only', async () => {
  const calls: Array<{ name: string; input: Record<string, unknown> }> = []
  const supabase = client({
    rpc: async (name: string, input: Record<string, unknown>) => {
      calls.push({ name, input })
      return { data: true, error: null }
    },
    from: () => { throw new Error('non-atomic fallback used') },
  })

  await saveAgentRunState(supabase, 'user', 'task', {
    repo: 'owner/repo',
    tier: '正构',
    messages: [{ role: 'user', content: 'hello' }],
    updatedAt: 'ignored',
  })

  assert.equal(calls[0]?.name, 'merge_agent_run_state')
  assert.equal(typeof calls[0]?.input.patch, 'object')
})

test('quota usage never falls back to a profile read-modify-write', async () => {
  let tableReads = 0
  let rpcInput: Record<string, unknown> | null = null
  const supabase = client({
    rpc: async (name: string, input: Record<string, unknown>) => {
      assert.equal(name, 'record_quota_usage')
      rpcInput = input
      return { data: true, error: null }
    },
    from: () => { tableReads += 1; throw new Error('non-atomic fallback used') },
  })

  await addQuotaUsage(supabase, 'user', 100, 'deepseek-v4-pro', true, true)
  assert.deepEqual(rpcInput, { weighted_tokens: 300, use_balance: true })
  assert.equal(tableReads, 0)
})
