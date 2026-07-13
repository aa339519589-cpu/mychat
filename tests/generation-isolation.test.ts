import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyConversationGenerationSnapshot,
  isRunning,
  mergeGenerationStreamText,
  normalizeConversationGenerationSnapshot,
  reduceClientGenerationState,
  toGenerationTerminalSnapshot,
  type ClientGenerationState,
} from '../lib/generation-client'
import {
  createGeneration,
  appendText,
  cancelGeneration,
  getGeneration,
  listRunningForConversation,
  setStatus,
} from '../lib/generation/runtime'

test('A running does not make B running (client helper)', () => {
  const byConv: Record<string, ClientGenerationState> = {
    A: { conversationId: 'A', status: 'running', generationId: 'g1' },
  }
  assert.equal(isRunning(byConv['A']), true)
  assert.equal(isRunning(byConv['B']), false)
  assert.equal(isRunning(undefined), false)
})

test('runtime isolates generations by conversation', () => {
  createGeneration({ id: 'gen-a', userId: 'u1', conversationId: 'A', assistantMessageId: 'm-a' })
  createGeneration({ id: 'gen-b', userId: 'u1', conversationId: 'B', assistantMessageId: 'm-b' })
  setStatus('gen-a', 'running')
  setStatus('gen-b', 'running')
  appendText('gen-a', 'hello-A')
  appendText('gen-b', 'hello-B')
  assert.equal(getGeneration('gen-a')?.record.content, 'hello-A')
  assert.equal(getGeneration('gen-b')?.record.content, 'hello-B')
  const runningA = listRunningForConversation('u1', 'A')
  assert.ok(runningA.some(r => r.id === 'gen-a'))
  assert.ok(!runningA.some(r => r.id === 'gen-b'))
})

test('cancel A does not cancel B', () => {
  createGeneration({ id: 'gen-a2', userId: 'u1', conversationId: 'A2', assistantMessageId: 'm-a2' })
  createGeneration({ id: 'gen-b2', userId: 'u1', conversationId: 'B2', assistantMessageId: 'm-b2' })
  setStatus('gen-a2', 'running')
  setStatus('gen-b2', 'running')
  cancelGeneration('gen-a2', 'u1')
  assert.equal(getGeneration('gen-a2')?.record.status, 'cancelled')
  assert.equal(getGeneration('gen-b2')?.record.status, 'running')
})

test('text append increases sequence without duplicating on snapshot semantics', () => {
  createGeneration({ id: 'gen-seq', userId: 'u1', conversationId: 'S', assistantMessageId: 'm-s' })
  setStatus('gen-seq', 'running')
  const e1 = appendText('gen-seq', 'x')
  const e2 = appendText('gen-seq', 'y')
  assert.ok(e1 && e2)
  assert.equal(e1!.sequence + 1, e2!.sequence)
  assert.equal(getGeneration('gen-seq')?.record.content, 'xy')
})

test('repeating the same terminal status is idempotent', () => {
  createGeneration({ id: 'gen-terminal', userId: 'u1', conversationId: 'T', assistantMessageId: 'm-t' })
  setStatus('gen-terminal', 'running')
  setStatus('gen-terminal', 'cancelled')
  const sequence = getGeneration('gen-terminal')?.record.sequence
  setStatus('gen-terminal', 'cancelled')
  assert.equal(getGeneration('gen-terminal')?.record.sequence, sequence)
})

test('runtime rejects a generation id reused with different ownership metadata', () => {
  createGeneration({ id: 'gen-collision', userId: 'u1', conversationId: 'C1', assistantMessageId: 'm1' })
  assert.throws(
    () => createGeneration({ id: 'gen-collision', userId: 'u2', conversationId: 'C2', assistantMessageId: 'm2' }),
    /identity collision/,
  )
})

test('resume snapshots do not append their included delta twice', () => {
  assert.deepEqual(
    mergeGenerationStreamText(
      { content: 'hello', thinking: 'plan' },
      { type: 'text', content: 'hello world', thinking: 'plan', delta: ' world' },
    ),
    { content: 'hello world', thinking: 'plan' },
  )
  assert.deepEqual(
    mergeGenerationStreamText(
      { content: 'hello', thinking: 'plan' },
      { type: 'thinking', delta: ' next' },
    ),
    { content: 'hello', thinking: 'plan next' },
  )
})

test('cold resume applies canonical terminal metadata to React state', () => {
  const snapshot = normalizeConversationGenerationSnapshot({
    id: 'g-cold',
    conversationId: 'conversation-cold',
    assistantMessageId: 'assistant-cold',
    status: 'failed',
    content: 'canonical-prefix',
    thinking: 'canonical-thinking',
    media: [],
    sequence: 17,
    error: 'provider_failed',
  })
  assert.ok(snapshot)
  assert.ok(toGenerationTerminalSnapshot(snapshot!))

  const [conversation] = applyConversationGenerationSnapshot([{
    id: 'conversation-cold',
    title: 'Cold',
    excerpt: '',
    date: 'today',
    messages: [{ id: 'assistant-cold', role: 'assistant', content: 'stale', time: '' }],
  }], 'conversation-cold', snapshot!)
  assert.equal(conversation.messages[0].content, 'canonical-prefix')
  assert.equal(conversation.messages[0].thinking, 'canonical-thinking')
  assert.equal(conversation.messages[0].isError, true)
  assert.equal(conversation.messages[0].outputWarning, 'provider_failed')
  assert.deepEqual(conversation.messages[0].generation, {
    id: 'g-cold',
    status: 'failed',
    sequence: 17,
    error: 'provider_failed',
  })
})

test('a stale running snapshot cannot regress an already terminal message', () => {
  const running = normalizeConversationGenerationSnapshot({
    id: 'g-race',
    conversationId: 'conversation-race',
    assistantMessageId: 'assistant-race',
    status: 'running',
    content: 'partial',
    thinking: '',
    media: [],
    sequence: 8,
    error: null,
  })!
  const [conversation] = applyConversationGenerationSnapshot([{
    id: 'conversation-race',
    title: 'Race',
    excerpt: '',
    date: 'today',
    messages: [{
      id: 'assistant-race',
      role: 'assistant',
      content: 'canonical',
      time: '',
      generation: { id: 'g-race', status: 'completed', sequence: 9, error: null },
    }],
  }], 'conversation-race', running)
  assert.equal(conversation.messages[0].content, 'canonical')
  assert.equal(conversation.messages[0].generation?.status, 'completed')
})

test('late generation A finalization cannot overwrite running generation B', () => {
  let state: Record<string, ClientGenerationState> = {}
  state = reduceClientGenerationState(state, 'conversation', {
    status: 'running', generationId: 'A', assistantMessageId: 'assistant-A', begin: true,
  })
  state = reduceClientGenerationState(state, 'conversation', {
    status: 'cancelled', generationId: 'A', assistantMessageId: 'assistant-A', authoritativeTerminal: true,
  })
  state = reduceClientGenerationState(state, 'conversation', {
    status: 'running', generationId: 'B', assistantMessageId: 'assistant-B', begin: true,
  })
  const beforeLateA = state
  state = reduceClientGenerationState(state, 'conversation', {
    status: 'cancelled', generationId: 'A', assistantMessageId: 'assistant-A', authoritativeTerminal: true,
  })
  assert.equal(state, beforeLateA)
  assert.equal(state.conversation.status, 'running')
  assert.equal(state.conversation.generationId, 'B')
  assert.equal(state.conversation.assistantMessageId, 'assistant-B')
})
