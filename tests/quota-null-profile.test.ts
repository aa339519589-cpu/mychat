import assert from 'node:assert/strict'
import test from 'node:test'
import type { SupabaseClient } from '@supabase/supabase-js'
import { checkQuotaExceeded } from '../lib/quota'

const userId = '91000000-0000-4000-8000-000000000001'

function quotaClient(data: unknown, error: unknown = null): SupabaseClient {
  return {
    rpc: async () => ({ data, error }),
  } as unknown as SupabaseClient
}

test('new principal with null profile values is admitted with default limits', async () => {
  const decision = await checkQuotaExceeded(quotaClient({
    tokens5h: 0,
    tokens7d: 0,
    balance: null,
    limit5h: null,
    limit7d: null,
    reservedQuotaTokens: 0,
    reservedBalanceTokens: 0,
  }), userId)

  assert.deepEqual(decision, { exceeded: false })
})

test('null profile balance cannot bypass a genuinely exceeded default window', async () => {
  const decision = await checkQuotaExceeded(quotaClient({
    tokens5h: 500_000,
    tokens7d: 500_000,
    balance: null,
    limit5h: null,
    limit7d: null,
  }), userId)

  assert.deepEqual(decision, { exceeded: true, which: '5h' })
})

test('malformed usage counters still fail closed as unavailable', async () => {
  const decision = await checkQuotaExceeded(quotaClient({
    tokens5h: null,
    tokens7d: 0,
    balance: null,
    limit5h: null,
    limit7d: null,
  }), userId)

  assert.deepEqual(decision, { exceeded: false, unavailable: true })
})
