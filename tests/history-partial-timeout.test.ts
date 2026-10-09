import assert from 'node:assert/strict'
import test from 'node:test'
import { prepareChatHistory } from '../lib/chat/history'

const source = { conversationId: 'old', conversationTitle: 'Autumn', messageStartId: 'm1', snippet: 'User chose autumn', createdAt: null }
const options = {
  supabase: null, userId: 'alice', conversationId: 'current', tier: 'custom', deadlineMs: 15,
  messages: [{ role: 'user', content: 'Please write an autumn story' }],
  historyRetrievalEnabled: true, customEndpoint: true, deferIndexing: true,
}

test('deadline retains completed retrieval branches and reports degraded instead of claiming full retrieval', async () => {
  let aborted = false
  const result = await prepareChatHistory(options, {
    prepareSummary: async () => ({ conversationId: 'current', renderedSummary: 'stored summary' }),
    retrieveHistory: async input => {
      input.onPartial?.({ renderedContext: '\ncompleted keyword and user context', sources: [source] })
      return new Promise((_resolve, reject) => input.signal?.addEventListener('abort', () => {
        aborted = true
        reject(input.signal?.reason)
      }, { once: true }))
    },
  })
  assert.equal(aborted, true)
  assert.equal(result.degraded, true)
  assert.equal(result.renderedContext, 'stored summary\ncompleted keyword and user context')
  assert.deepEqual(result.sources, [source])
})

test('normal completion returns the full result after partial progress without degraded status', async () => {
  const result = await prepareChatHistory({ ...options, deadlineMs: 200 }, {
    prepareSummary: async () => ({ conversationId: 'current', renderedSummary: 'stored summary' }),
    retrieveHistory: async input => {
      input.onPartial?.({ renderedContext: '\npartial', sources: [source] })
      return { renderedContext: '\nfull ordered retrieval', sources: [source] }
    },
  })
  assert.equal(result.degraded, undefined)
  assert.equal(result.renderedContext, 'stored summary\nfull ordered retrieval')
  assert.deepEqual(result.sources, [source])
})
