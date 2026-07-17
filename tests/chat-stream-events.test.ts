import assert from 'node:assert/strict'
import test from 'node:test'
import type { Dispatch, SetStateAction } from 'react'
import type { Conversation } from '../lib/chat-data'
import type { Memory } from '../lib/memory-data'
import {
  processChatStreamEvent,
  type ChatStreamEventContext,
} from '../components/literary-chat/chat-stream-events'
import { createChatStreamState } from '../components/literary-chat/chat-stream-state'
import type { JobStreamEnvelope } from '../components/literary-chat/job-stream-client'

function stateDispatch<T>(initial: T) {
  let current = initial
  const dispatch: Dispatch<SetStateAction<T>> = action => {
    current = typeof action === 'function'
      ? (action as (previous: T) => T)(current)
      : action
  }
  return { dispatch, current: () => current }
}

function harness() {
  const conversations = stateDispatch<Conversation[]>([{
    id: 'conversation',
    title: 'Title',
    excerpt: '',
    date: '今日',
    messages: [
      { id: 'user', role: 'user', content: 'hello', time: '' },
      { id: 'assistant', role: 'assistant', content: '', time: '' },
    ],
  }])
  const memories = stateDispatch<Memory[]>([])
  const calls = { cancel: 0, flush: 0, schedule: 0 }
  const context: ChatStreamEventContext = {
    state: createChatStreamState(),
    renderer: {
      cancel: () => { calls.cancel++ },
      flush: () => { calls.flush++ },
      schedule: () => { calls.schedule++ },
    },
    conversationId: 'conversation',
    assistantMessageId: 'assistant',
    setConversations: conversations.dispatch,
    setMemories: memories.dispatch,
  }
  return { context, calls, conversations, memories }
}

function event(kind: string, payload: Record<string, unknown>, seq = 1): JobStreamEnvelope {
  return { jobId: 'job', seq, kind, payload }
}

test('chat stream reducer applies bounded auxiliary events and rejects unsafe search URLs', () => {
  const fixture = harness()
  assert.equal(processChatStreamEvent(fixture.context, event('tool.memory', {
    memory: { action: 'create', ok: true, id: 'memory', content: 'preference' },
  })), true)
  assert.equal(processChatStreamEvent(fixture.context, event('tool.search', {
    search: {
      query: 'topic',
      results: [
        { title: 'Docs', url: 'https://example.com/docs' },
        { title: 'Script', url: 'javascript:alert(1)' },
        { title: 'Credentials', url: 'https://user:pass@example.com' },
      ],
    },
  }, 2)), true)
  assert.equal(processChatStreamEvent(fixture.context, event('context.image_summary', {
    imageSummary: { messageId: 'user', summary: 'diagram' },
  }, 3)), true)

  const conversation = fixture.conversations.current()[0]
  assert.deepEqual(conversation.messages[1]?.memoryNotes, ['记住了：preference'])
  assert.deepEqual(conversation.messages[1]?.searchNotes, [{
    query: 'topic',
    results: [{ title: 'Docs', url: 'https://example.com/docs' }],
  }])
  assert.equal(conversation.messages[0]?.imageSummary, 'diagram')
  assert.deepEqual(fixture.memories.current(), [
    { id: 'memory', content: 'preference', timestamp: undefined },
  ])
})

test('chat stream reducer accumulates deltas, deduplicates media, and resets retries', () => {
  const fixture = harness()
  const media = { type: 'image', url: 'https://example.com/image.png', mimeType: 'image/png' }
  processChatStreamEvent(fixture.context, event('text.delta', { text: 'answer' }))
  processChatStreamEvent(fixture.context, event('thinking.delta', { thinking: 'reason' }, 2))
  processChatStreamEvent(fixture.context, event('media.uploaded', { media }, 3))
  processChatStreamEvent(fixture.context, event('media.uploaded', { media }, 4))
  assert.equal(fixture.context.state.fullReply, 'answer')
  assert.equal(fixture.context.state.fullThinking, 'reason')
  assert.equal(fixture.context.state.fullMedia.length, 1)
  assert.equal(fixture.calls.schedule, 3)

  assert.equal(processChatStreamEvent(fixture.context, event('job.retry_scheduled', {}, 5)), true)
  assert.equal(fixture.context.state.fullReply, '')
  assert.equal(fixture.context.state.fullThinking, '')
  assert.deepEqual(fixture.context.state.fullMedia, [])
  assert.equal(fixture.calls.cancel, 1)
  assert.equal(fixture.calls.flush, 1)
})

test('chat stream reducer accepts only canonical terminal snapshots and stops on errors', () => {
  const valid = harness()
  valid.context.state.fullReply = 'partial'
  assert.equal(processChatStreamEvent(valid.context, event('job.terminal', {
    status: 'completed',
    result: { content: 'canonical', thinking: '', media: [] },
    errorCode: null,
  }, 9)), true)
  assert.equal(valid.context.state.authoritativeTerminal?.content, 'canonical')
  assert.equal(valid.context.state.fullReply, 'canonical')

  const invalid = harness()
  assert.equal(processChatStreamEvent(invalid.context, event('job.terminal', {
    status: 'running', result: {},
  })), false)
  assert.match(invalid.context.state.terminalError ?? '', /终态响应无效/)

  const failed = harness()
  assert.equal(processChatStreamEvent(failed.context, event('job.warning', { error: 'offline' })), false)
  assert.equal(failed.context.state.terminalError, 'offline')
  assert.equal(failed.calls.cancel, 1)
})
