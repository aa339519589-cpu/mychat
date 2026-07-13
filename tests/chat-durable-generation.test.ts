import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createDurableChatGenerationResponse,
  type DurableChatGenerationOptions,
} from '../lib/chat/durable-generation'
import { cancelGeneration, getGeneration } from '../lib/generation/runtime'
import { customModelCapability } from '../lib/llm/models'

const USER_ID = 'durable-test-user'

function generationOptions(
  requestSignal: AbortSignal,
  generationId: string,
  assistantMessageId: string,
): DurableChatGenerationOptions {
  return {
    requestSignal,
    auth: { supabase: null, userId: USER_ID },
    body: {
      tier: '绝句',
      messages: [{ role: 'user', content: 'hello' }],
      generationId,
      assistantMessageId,
    },
    selection: {
      customEndpoint: true,
      model: 'custom-chat-model',
      thinking: false,
      capability: customModelCapability('custom-chat-model', 'https://models.example/v1'),
      apiKey: 'test-api-key',
      authType: 'none',
      outputKind: 'chat',
      endpointDisplayName: 'Test endpoint',
    },
    memoryEnabled: true,
    usingBalance: false,
    searchMode: 'off',
    hasScannedAttachment: false,
  }
}

function dataFrames(raw: string): string[] {
  return raw.trim().split('\n\n').map(frame => frame.replace(/^data: /, ''))
}

test('durable chat sends metadata before model deltas and persists streamed output', async () => {
  const request = new AbortController()
  const generationId = '10000000-0000-4000-8000-000000000001'
  const assistantMessageId = '20000000-0000-4000-8000-000000000001'
  let modelSignal: AbortSignal | undefined

  const response = createDurableChatGenerationResponse(
    generationOptions(request.signal, generationId, assistantMessageId),
    {
      runAgentLoop: async options => {
        modelSignal = options.turnOptions?.signal
        options.emit({ thinking: 'working' })
        options.emit({ text: 'answer' })
        options.onUsage?.(9)
        return { totalTokens: 9 }
      },
      maybeGc: () => undefined,
    },
  )

  assert.equal(response.headers.get('content-type'), 'text/event-stream')
  assert.equal(response.headers.get('cache-control'), 'no-cache')
  assert.deepEqual(dataFrames(await response.text()), [
    JSON.stringify({ heartbeat: true }),
    JSON.stringify({ generationId, assistantMessageId }),
    JSON.stringify({ thinking: 'working' }),
    JSON.stringify({ text: 'answer' }),
    '[DONE]',
  ])
  assert.notEqual(modelSignal, request.signal)
  assert.equal(modelSignal?.aborted, false)
  assert.equal(getGeneration(generationId)?.record.status, 'completed')
  assert.equal(getGeneration(generationId)?.record.thinking, 'working')
  assert.equal(getGeneration(generationId)?.record.content, 'answer')
})

test('client disconnect stops SSE writes without aborting durable generation', async () => {
  const request = new AbortController()
  const generationId = '10000000-0000-4000-8000-000000000002'
  const assistantMessageId = '20000000-0000-4000-8000-000000000002'
  let startModel!: () => void
  const modelStarted = new Promise<void>(resolve => { startModel = resolve })
  let releaseModel!: () => void
  const modelReleased = new Promise<void>(resolve => { releaseModel = resolve })
  let finishService!: () => void
  const serviceFinished = new Promise<void>(resolve => { finishService = resolve })
  let modelSignal: AbortSignal | undefined

  const response = createDurableChatGenerationResponse(
    generationOptions(request.signal, generationId, assistantMessageId),
    {
      runAgentLoop: async options => {
        modelSignal = options.turnOptions?.signal
        startModel()
        await modelReleased
        options.emit({ text: 'finished after disconnect' })
        return { totalTokens: 0 }
      },
      maybeGc: () => { finishService() },
    },
  )

  await modelStarted
  request.abort(new DOMException('browser disconnected', 'AbortError'))
  await response.body?.cancel()
  assert.equal(modelSignal?.aborted, false)
  releaseModel()
  await serviceFinished

  assert.equal(getGeneration(generationId)?.record.status, 'completed')
  assert.equal(getGeneration(generationId)?.record.content, 'finished after disconnect')
})

test('explicit generation cancellation aborts the model signal without emitting an error', async () => {
  const request = new AbortController()
  const generationId = '10000000-0000-4000-8000-000000000003'
  const assistantMessageId = '20000000-0000-4000-8000-000000000003'
  let startModel!: () => void
  const modelStarted = new Promise<void>(resolve => { startModel = resolve })

  const response = createDurableChatGenerationResponse(
    generationOptions(request.signal, generationId, assistantMessageId),
    {
      runAgentLoop: async options => {
        const signal = options.turnOptions?.signal
        assert.ok(signal)
        startModel()
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
        return { totalTokens: 0 }
      },
      maybeGc: () => undefined,
    },
  )

  await modelStarted
  assert.equal(cancelGeneration(generationId, USER_ID), true)
  const raw = await response.text()

  assert.equal(getGeneration(generationId)?.record.status, 'cancelled')
  assert.equal(raw.includes('"error"'), false)
  assert.equal(dataFrames(raw).at(-1), '[DONE]')
})
