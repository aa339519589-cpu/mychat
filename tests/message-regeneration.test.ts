import assert from 'node:assert/strict'
import test from 'node:test'
import type { Dispatch, SetStateAction } from 'react'
import type { User } from '@supabase/supabase-js'
import type { Conversation } from '../lib/chat-data'
import { regenerateFromUser, regenerateLastAssistant } from '../components/literary-chat/message-regeneration'

function conversation(): Conversation {
  return {
    id: '92000000-0000-4000-8000-000000000001',
    title: 'Authority',
    excerpt: '',
    date: '今日',
    messages: [
      { id: '92000000-0000-4000-8000-000000000002', role: 'user', content: 'first', time: '' },
      { id: '92000000-0000-4000-8000-000000000003', role: 'assistant', content: 'first reply', time: '' },
      { id: '92000000-0000-4000-8000-000000000004', role: 'user', content: 'second', time: '' },
      { id: '92000000-0000-4000-8000-000000000005', role: 'assistant', content: 'second reply', time: '' },
    ],
  }
}

function state(initial: Conversation[]) {
  let value = initial
  const set: Dispatch<SetStateAction<Conversation[]>> = update => {
    value = typeof update === 'function' ? update(value) : update
  }
  return { get: () => value, set }
}

function openArtifactSetter(): Dispatch<SetStateAction<string | null>> {
  let value: string | null = 'artifact'
  return update => { value = typeof update === 'function' ? update(value) : update }
}

const user = { id: '92000000-0000-4000-8000-000000000010' } as User

test('assistant regeneration retains the old reply until the server accepts the transaction', async () => {
  const active = conversation()
  const conversations = state([active])
  await regenerateLastAssistant({
    user,
    active,
    activeId: active.id,
    isActiveGenerating: false,
    setOpenArtifactId: openArtifactSetter(),
    setConversations: conversations.set,
    markGeneration: () => undefined,
    getProjectContext: async () => undefined,
    registerAbort: () => undefined,
    startStream: async (_history, assistantMessageId, _conversationId, _controller,
      _attachments, _project, _generationId, authority, onAccepted) => {
      assert.equal(conversations.get()[0]?.messages.at(-1)?.content, 'second reply')
      assert.deepEqual(authority, {
        schemaVersion: 2,
        operation: 'replace-assistant',
        expectedTailMessageId: '92000000-0000-4000-8000-000000000005',
        targetAssistantMessageId: '92000000-0000-4000-8000-000000000005',
      })
      onAccepted?.()
      assert.equal(conversations.get()[0]?.messages.at(-1)?.id, assistantMessageId)
      assert.equal(conversations.get()[0]?.messages.at(-1)?.content, '')
      return { content: 'replacement', status: 'completed', accepted: true }
    },
  })
  assert.equal(conversations.get()[0]?.messages.length, 4)
  assert.notEqual(conversations.get()[0]?.messages.at(-1)?.id,
    '92000000-0000-4000-8000-000000000005')
})

test('rejected assistant regeneration leaves the durable reply visible with a warning', async () => {
  const active = conversation()
  const conversations = state([active])
  await regenerateLastAssistant({
    user,
    active,
    activeId: active.id,
    isActiveGenerating: false,
    setOpenArtifactId: openArtifactSetter(),
    setConversations: conversations.set,
    markGeneration: () => undefined,
    getProjectContext: async () => undefined,
    registerAbort: () => undefined,
    startStream: async () => ({ content: '', status: 'error', accepted: false }),
  })
  assert.equal(conversations.get()[0]?.messages.at(-1)?.id,
    '92000000-0000-4000-8000-000000000005')
  assert.match(conversations.get()[0]?.messages.at(-1)?.outputWarning ?? '', /原回复已保留/)
})

test('edited regeneration replaces the local branch only after database acceptance', async () => {
  const active = conversation()
  const conversations = state([active])
  await regenerateFromUser({
    user,
    active,
    activeId: active.id,
    isActiveGenerating: false,
    setOpenArtifactId: openArtifactSetter(),
    setConversations: conversations.set,
    markGeneration: () => undefined,
    getProjectContext: async () => undefined,
    registerAbort: () => undefined,
    userMessageId: '92000000-0000-4000-8000-000000000002',
    editedContent: 'edited first',
    startStream: async (history, assistantMessageId, _conversationId, _controller,
      _attachments, _project, _generationId, authority, onAccepted) => {
      assert.equal(conversations.get()[0]?.messages.length, 4)
      assert.equal(conversations.get()[0]?.messages[0]?.content, 'first')
      assert.equal(history.at(-1)?.content, 'edited first')
      assert.deepEqual(authority, {
        schemaVersion: 2,
        operation: 'replace-from-user',
        expectedTailMessageId: '92000000-0000-4000-8000-000000000005',
      })
      onAccepted?.()
      assert.deepEqual(conversations.get()[0]?.messages.map(message => message.content), [
        'edited first', '',
      ])
      assert.equal(conversations.get()[0]?.messages[1]?.id, assistantMessageId)
      return { content: 'edited reply', status: 'completed', accepted: true }
    },
  })
})
