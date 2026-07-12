import assert from 'node:assert/strict'
import test from 'node:test'
import { isRunning, type ClientGenerationState } from '../lib/generation-client'
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
  const a = createGeneration({ id: 'gen-a', userId: 'u1', conversationId: 'A', assistantMessageId: 'm-a' })
  const b = createGeneration({ id: 'gen-b', userId: 'u1', conversationId: 'B', assistantMessageId: 'm-b' })
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
