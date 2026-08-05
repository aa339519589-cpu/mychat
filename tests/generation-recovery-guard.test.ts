import assert from 'node:assert/strict'
import test from 'node:test'
import type { Conversation } from '../lib/chat-data'
import {
  hasActiveConversationGeneration,
  resumeConversationGeneration,
} from '../components/literary-chat/generation-api'

const job = {
  id: '92000000-0000-4000-8000-000000000001',
  status: 'running',
  subject: {},
  progress: {},
  result: null,
  errorCode: null,
  eventSequence: 0,
}

test('recovery guard recognizes an accepted non-terminal generation', async () => {
  const active = await hasActiveConversationGeneration('conversation id', async url => {
    assert.equal(url, '/api/v1/conversations/conversation%20id/generation')
    return Response.json({ job, streamUrl: '/events' })
  })
  assert.equal(active, true)
})

test('recovery guard permits a new enqueue after a terminal or unavailable lookup', async () => {
  assert.equal(await hasActiveConversationGeneration('conversation', async () => Response.json({
    job: { ...job, status: 'completed' }, streamUrl: '/events',
  })), false)
  assert.equal(await hasActiveConversationGeneration('conversation', async () => new Response(null, {
    status: 503,
  })), false)
})

test('terminal recovery unlocks generation when the local cache stalls', async () => {
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const originalFetch = globalThis.fetch
  const statuses: string[] = []
  let reconciled = false
  let conversations: Conversation[] = [{
    id: 'conversation',
    title: 'Title',
    excerpt: '',
    date: '今日',
    messages: [{ id: 'assistant', role: 'assistant', content: '', time: '' }],
  }]
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      indexedDB: {
        open: (name: string) => {
          const request: { onerror?: () => void } = {}
          if (name === 'mychat-pending-chat-submissions') {
            queueMicrotask(() => request.onerror?.())
          }
          return request
        },
      },
      localStorage: {
        getItem: () => null,
        setItem: () => undefined,
        removeItem: () => undefined,
      },
    },
  })
  globalThis.fetch = async () => Response.json({
    job: {
      ...job,
      status: 'completed',
      subject: { assistantMessageId: 'assistant' },
      result: { content: '完整回复', thinking: '', media: [] },
      eventSequence: 3,
    },
    streamUrl: '/events',
  })

  try {
    await Promise.race([
      resumeConversationGeneration({
        conversationId: 'conversation',
        showTokenUsage: false,
        setConversations: action => {
          conversations = typeof action === 'function' ? action(conversations) : action
        },
        markGeneration: (_conversationId, patch) => { statuses.push(patch.status) },
        registerAbort: () => { assert.fail('terminal recovery must not register an abort controller') },
        clearAbort: () => undefined,
        onReconciled: available => { reconciled = available },
      }),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error('terminal recovery remained blocked')), 500)
      }),
    ])

    assert.deepEqual(statuses, ['completed'])
    assert.equal(reconciled, true)
    assert.equal(conversations[0]?.messages[0]?.content, '完整回复')
    assert.equal(conversations[0]?.messages[0]?.generation?.status, 'completed')
  } finally {
    globalThis.fetch = originalFetch
    if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})
