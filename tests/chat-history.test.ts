import assert from 'node:assert/strict'
import test from 'node:test'
import { prepareChatHistory } from '../lib/chat/history'
import type { SupabaseServer } from '../lib/api/guard'

const conversationId = '20000000-0000-4000-8000-000000000001'
const userId = '10000000-0000-4000-8000-000000000001'

test('disabled history retrieval bypasses all summary and retrieval storage work', async () => {
  let storageCalls = 0
  const storage = {
    from() {
      storageCalls++
      throw new Error('history storage must not be touched')
    },
  } as unknown as SupabaseServer

  const result = await prepareChatHistory({
    supabase: storage,
    userId,
    conversationId,
    messages: [{ id: '30000000-0000-4000-8000-000000000001', role: 'user', content: 'hello' }],
    tier: '绝句',
    historyRetrievalEnabled: false,
    customEndpoint: false,
  })

  assert.equal(storageCalls, 0)
  assert.deepEqual(result, { conversationId, renderedContext: '' })
})
