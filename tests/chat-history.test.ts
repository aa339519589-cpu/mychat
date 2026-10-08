import assert from 'node:assert/strict'
import test from 'node:test'
import { needsCrossConversationHistory, prepareChatHistory } from '../lib/chat/history'
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

test('isolated reactions skip cross-conversation retrieval without losing stored current context', async () => {
  const touched: string[] = []
  const query = {
    select() { return query }, eq() { return query },
    async maybeSingle() {
      return { data: { context_summary: '当前对话约定使用中文', summary_until_message_id: 'previous-message' }, error: null }
    },
  }
  const storage = { from(table: string) {
    touched.push(table)
    assert.equal(table, 'conversations')
    return query
  } } as unknown as SupabaseServer
  const result = await prepareChatHistory({
    supabase: storage, userId, conversationId, tier: '绝句',
    historyRetrievalEnabled: true, customEndpoint: true, deferIndexing: true,
    messages: [{ role: 'user', content: '哈哈哈' }],
  })
  assert.deepEqual(touched, ['conversations'])
  assert.match(result.renderedContext, /当前对话约定使用中文/)
  assert.equal(result.sources, undefined)
})

test('worker history lookup starts before summary finishes and waits for both contexts', async () => {
  let finishSummary!: (value: { conversationId: string; renderedSummary: string }) => void
  let finishHistory!: (value: { renderedContext: string; sources: [] }) => void
  let retrievalStarted = false
  let finished = false
  const pending = prepareChatHistory({
    supabase: null, userId, conversationId, tier: '绝句',
    historyRetrievalEnabled: true, customEndpoint: true, deferIndexing: true,
    messages: [{ role: 'user', content: '继续昨天的项目计划' }],
  }, {
    prepareSummary: () => new Promise(resolve => { finishSummary = resolve }),
    retrieveHistory: options => {
      retrievalStarted = true
      assert.equal(options.conversationId, conversationId)
      return new Promise(resolve => { finishHistory = resolve })
    },
  }).then(value => { finished = true; return value })
  assert.equal(retrievalStarted, true, 'retrieval must not wait for the summary read')
  finishHistory({ renderedContext: 'history-context', sources: [] })
  await Promise.resolve()
  assert.equal(finished, false, 'model context still needs the current summary')
  finishSummary({ conversationId, renderedSummary: 'summary-context' })
  const result = await pending
  assert.equal(result.renderedContext, 'summary-contexthistory-context')
})

test('history lookup remains enabled for every contextual or factual request', () => {
  for (const query of ['哈哈哈', '呵呵', '你好呀！', '谢谢', 'hello']) {
    assert.equal(needsCrossConversationHistory(query), false, query)
  }
  for (const query of ['哈哈哈 上次那项目', '你好，上次我的名字是什么？', '谢谢，继续昨天的计划', '好，那个文件呢', 'hello remember my project', '哈雷发动机']) {
    assert.equal(needsCrossConversationHistory(query), true, query)
  }
})

test('a stalled optional history branch is cancelled and does not hold the main model for its lease', async () => {
  let aborted = false
  const result = await prepareChatHistory({
    supabase: null, userId, conversationId, tier: '绝句', deadlineMs: 15,
    historyRetrievalEnabled: true, customEndpoint: false, deferIndexing: true,
    messages: [{ role: 'user', content: '请解释月亮的形状为什么变化' }],
  }, {
    prepareSummary: async () => ({ conversationId, renderedSummary: 'current context' }),
    retrieveHistory: options => new Promise((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => { aborted = true; reject(options.signal?.reason) }, { once: true })
    }),
  })
  assert.equal(result.degraded, true)
  assert.equal(result.renderedContext, 'current context')
  assert.equal(aborted, true)
})
