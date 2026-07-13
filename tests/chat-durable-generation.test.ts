import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createDurableChatGenerationResponse,
  type DurableChatGenerationOptions,
} from '../lib/chat/durable-generation'
import { runChatStream } from '../components/literary-chat/chat-stream-service'
import type { Conversation } from '../lib/chat-data'
import { cancelGeneration, getGeneration } from '../lib/generation/runtime'
import { customModelCapability } from '../lib/llm/models'

const USER_ID = 'durable-test-user'
const SESSION_SUPABASE = {} as NonNullable<DurableChatGenerationOptions['auth']['supabase']>

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

  const response = await createDurableChatGenerationResponse(
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
    JSON.stringify({
      terminal: {
        status: 'completed',
        content: 'answer',
        thinking: 'working',
        sequence: 4,
        error: null,
        media: [],
      },
    }),
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

  const response = await createDurableChatGenerationResponse(
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

  const response = await createDurableChatGenerationResponse(
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
  assert.equal(raw.includes('data: {"error":'), false)
  assert.equal(raw.includes('"terminal":{"status":"cancelled"'), true)
  assert.equal(dataFrames(raw).at(-1), '[DONE]')
})

test('database cancellation from another instance aborts the active runner', async () => {
  const request = new AbortController()
  const generationId = '10000000-0000-4000-8000-000000000004'
  const assistantMessageId = '20000000-0000-4000-8000-000000000004'
  const options = generationOptions(request.signal, generationId, assistantMessageId)
  options.auth.supabase = SESSION_SUPABASE
  options.body.conversationId = '30000000-0000-4000-8000-000000000004'
  let modelSignal: AbortSignal | undefined

  const response = await createDurableChatGenerationResponse(options, {
    claimGenerationLease: async input => ({
      ok: true,
      acquired: true,
      status: 'running',
      lease: {
        runnerId: input.runnerId,
        version: 1,
        expiresAt: new Date(Date.now() + 45_000).toISOString(),
      },
      media: [],
    }),
    persistGenerationProgress: async () => ({ ok: true, accepted: true, status: 'running', media: [] }),
    renewGenerationLease: async () => 'renewed',
    finalizeGenerationLease: async () => ({
      ok: true,
      accepted: false,
      status: 'cancelled',
      content: '',
      thinking: '',
      sequence: 2,
      media: [],
    }),
    loadGenerationStatusFromDb: async () => ({ kind: 'found', value: 'cancelled' }),
    cancellationPollIntervalMs: 10,
    runAgentLoop: async loopOptions => {
      modelSignal = loopOptions.turnOptions?.signal
      assert.ok(modelSignal)
      await new Promise<void>((_resolve, reject) => {
        modelSignal!.addEventListener('abort', () => reject(modelSignal!.reason), { once: true })
      })
      return { totalTokens: 0 }
    },
    maybeGc: () => undefined,
  })

  const raw = await response.text()
  assert.equal(modelSignal?.aborted, true)
  assert.equal(getGeneration(generationId)?.record.status, 'cancelled')
  assert.equal(raw.includes('data: {"error":'), false)
  assert.equal(raw.includes('"terminal":{"status":"cancelled"'), true)
  assert.equal(dataFrames(raw).at(-1), '[DONE]')
})

test('coordination read failure fences the runner and emits only the confirmed database failure', async () => {
  const generationId = '10000000-0000-4000-8000-000000000010'
  const assistantMessageId = '20000000-0000-4000-8000-000000000010'
  const options = generationOptions(new AbortController().signal, generationId, assistantMessageId)
  options.auth.supabase = SESSION_SUPABASE
  options.body.conversationId = '30000000-0000-4000-8000-000000000010'

  const response = await createDurableChatGenerationResponse(options, {
    claimGenerationLease: async input => ({
      ok: true,
      acquired: true,
      status: 'running',
      lease: {
        runnerId: input.runnerId,
        version: 10,
        expiresAt: new Date(Date.now() + 45_000).toISOString(),
      },
      media: [],
    }),
    persistGenerationProgress: async () => ({ ok: true, accepted: true, status: 'running', media: [] }),
    renewGenerationLease: async () => 'renewed',
    loadGenerationStatusFromDb: async () => ({
      kind: 'unavailable',
      reason: 'query_timeout',
    }),
    finalizeGenerationLease: async () => ({
      ok: true,
      accepted: true,
      status: 'failed',
      content: 'database-safe-prefix',
      thinking: '',
      sequence: 3,
      error: 'coordination_lost',
      media: [],
    }),
    cancellationPollIntervalMs: 10,
    runAgentLoop: async loopOptions => {
      const signal = loopOptions.turnOptions?.signal
      assert.ok(signal)
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
      return { totalTokens: 0 }
    },
    maybeGc: () => undefined,
  })

  const frames = dataFrames(await response.text())
  assert.equal(frames.at(-2), JSON.stringify({
    terminal: {
      status: 'failed',
      content: 'database-safe-prefix',
      thinking: '',
      sequence: 3,
      error: 'coordination_lost',
      media: [],
    },
  }))
  assert.equal(frames.at(-1), '[DONE]')
})

test('an active lease loser returns 409 before starting model or tools', async () => {
  const generationId = '10000000-0000-4000-8000-000000000005'
  const assistantMessageId = '20000000-0000-4000-8000-000000000005'
  const options = generationOptions(new AbortController().signal, generationId, assistantMessageId)
  options.auth.supabase = SESSION_SUPABASE
  options.body.conversationId = '30000000-0000-4000-8000-000000000005'
  let modelRuns = 0
  let localCreates = 0

  const response = await createDurableChatGenerationResponse(options, {
    claimGenerationLease: async () => ({
      ok: true,
      acquired: false,
      status: 'running',
      reason: 'active',
      media: [],
    }),
    createGeneration: input => {
      localCreates += 1
      throw new Error(`unexpected local generation ${input.id}`)
    },
    runAgentLoop: async () => {
      modelRuns += 1
      return { totalTokens: 0 }
    },
  })

  assert.equal(response.status, 409)
  assert.equal((await response.json()).reason, 'active')
  assert.equal(modelRuns, 0)
  assert.equal(localCreates, 0)
})

test('an expired generation is reported stale and never replayed', async () => {
  const generationId = '10000000-0000-4000-8000-000000000006'
  const assistantMessageId = '20000000-0000-4000-8000-000000000006'
  const options = generationOptions(new AbortController().signal, generationId, assistantMessageId)
  options.auth.supabase = SESSION_SUPABASE
  options.body.conversationId = '30000000-0000-4000-8000-000000000006'
  let modelRuns = 0

  const response = await createDurableChatGenerationResponse(options, {
    claimGenerationLease: async () => ({
      ok: true,
      acquired: false,
      status: 'failed',
      reason: 'stale',
      media: [],
    }),
    runAgentLoop: async () => {
      modelRuns += 1
      return { totalTokens: 0 }
    },
  })

  assert.equal(response.status, 409)
  assert.deepEqual(await response.json(), {
    error: '生成任务已由其他执行进程处理',
    generationId,
    status: 'failed',
    reason: 'stale',
  })
  assert.equal(modelRuns, 0)
})

test('database terminal CAS overrides a locally completed snapshot', async () => {
  const generationId = '10000000-0000-4000-8000-000000000007'
  const assistantMessageId = '20000000-0000-4000-8000-000000000007'
  const options = generationOptions(new AbortController().signal, generationId, assistantMessageId)
  options.auth.supabase = SESSION_SUPABASE
  options.body.conversationId = '30000000-0000-4000-8000-000000000007'

  const response = await createDurableChatGenerationResponse(options, {
    claimGenerationLease: async input => ({
      ok: true,
      acquired: true,
      status: 'running',
      lease: {
        runnerId: input.runnerId,
        version: 7,
        expiresAt: new Date(Date.now() + 45_000).toISOString(),
      },
      media: [],
    }),
    persistGenerationProgress: async () => ({ ok: true, accepted: true, status: 'running', media: [] }),
    renewGenerationLease: async () => 'renewed',
    loadGenerationStatusFromDb: async () => ({ kind: 'found', value: 'running' }),
    finalizeGenerationLease: async () => ({
      ok: true,
      accepted: false,
      status: 'cancelled',
      content: 'database-prefix',
      thinking: 'database-thinking',
      sequence: 12,
      media: [],
    }),
    runAgentLoop: async loopOptions => {
      loopOptions.emit({ text: 'local-completion' })
      return { totalTokens: 0 }
    },
    maybeGc: () => undefined,
  })

  const raw = await response.text()
  const record = getGeneration(generationId)?.record
  assert.equal(record?.status, 'cancelled')
  assert.equal(record?.content, 'database-prefix')
  assert.equal(record?.thinking, 'database-thinking')
  assert.equal(raw.includes('data: {"error":'), false)
  assert.equal(dataFrames(raw).at(-2), JSON.stringify({
    terminal: {
      status: 'cancelled',
      content: 'database-prefix',
      thinking: 'database-thinking',
      sequence: 12,
      error: null,
      media: [],
    },
  }))
  assert.equal(dataFrames(raw).at(-1), '[DONE]')
})

test('a fenced runner mirrors the stale database failure without invoking the model', async () => {
  const generationId = '10000000-0000-4000-8000-000000000008'
  const assistantMessageId = '20000000-0000-4000-8000-000000000008'
  const options = generationOptions(new AbortController().signal, generationId, assistantMessageId)
  options.auth.supabase = SESSION_SUPABASE
  options.body.conversationId = '30000000-0000-4000-8000-000000000008'
  let modelRuns = 0
  const stale = {
    ok: true as const,
    accepted: false,
    status: 'failed' as const,
    error: 'stale_generation_lease_expired',
    content: 'durable-prefix',
    thinking: '',
    sequence: 4,
    media: [],
  }

  const response = await createDurableChatGenerationResponse(options, {
    claimGenerationLease: async input => ({
      ok: true,
      acquired: true,
      status: 'running',
      lease: {
        runnerId: input.runnerId,
        version: 1,
        expiresAt: new Date(Date.now() + 45_000).toISOString(),
      },
      media: [],
    }),
    persistGenerationProgress: async () => stale,
    finalizeGenerationLease: async () => stale,
    loadGenerationStatusFromDb: async () => ({ kind: 'found', value: 'failed' }),
    runAgentLoop: async () => {
      modelRuns += 1
      return { totalTokens: 0 }
    },
    maybeGc: () => undefined,
  })

  const raw = await response.text()
  assert.equal(modelRuns, 0)
  assert.equal(getGeneration(generationId)?.record.status, 'failed')
  assert.equal(getGeneration(generationId)?.record.content, 'durable-prefix')
  assert.equal(raw.includes('stale_generation_lease_expired'), true)
  assert.equal(dataFrames(raw).at(-1), '[DONE]')
})

test('cancel-winning database snapshot flows through direct chat SSE and replaces client deltas', async t => {
  const generationId = '10000000-0000-4000-8000-000000000009'
  const assistantMessageId = '20000000-0000-4000-8000-000000000009'
  const conversationId = '30000000-0000-4000-8000-000000000009'
  const options = generationOptions(new AbortController().signal, generationId, assistantMessageId)
  options.auth.supabase = SESSION_SUPABASE
  options.body.conversationId = conversationId
  let orphanCleanups = 0

  const serverResponse = await createDurableChatGenerationResponse(options, {
    claimGenerationLease: async input => ({
      ok: true,
      acquired: true,
      status: 'running',
      lease: {
        runnerId: input.runnerId,
        version: 9,
        expiresAt: new Date(Date.now() + 45_000).toISOString(),
      },
      media: [],
    }),
    persistGenerationProgress: async () => ({ ok: true, accepted: true, status: 'running', media: [] }),
    renewGenerationLease: async () => 'renewed',
    loadGenerationStatusFromDb: async () => ({ kind: 'found', value: 'running' }),
    finalizeGenerationLease: async () => ({
      ok: true,
      accepted: false,
      status: 'cancelled',
      content: 'database-prefix',
      thinking: 'database-thinking',
      sequence: 21,
      media: [],
    }),
    runAgentLoop: async loopOptions => {
      loopOptions.emit({ thinking: 'local-thinking-that-lost' })
      loopOptions.emit({ media: { type: 'image', url: 'data:image/png;base64,bG9zdA==' } })
      loopOptions.emit({ text: 'local-completion-that-lost' })
      return { totalTokens: 0 }
    },
    persistMediaList: async (_context, media) => ({
      media: media.map(item => ({
        ...item,
        url: `https://project.supabase.co/storage/v1/object/public/generated-media/${USER_ID}/${conversationId}/${generationId}/lost.png`,
        mimeType: 'image/png',
      })),
      receipts: [{
        bucket: 'generated-media',
        objectKey: `${USER_ID}/${conversationId}/${generationId}/lost.png`,
      }],
    }),
    cleanupMedia: async () => { orphanCleanups += 1 },
    maybeGc: () => undefined,
  })

  const originalFetch = globalThis.fetch
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame
  globalThis.fetch = (async input => {
    assert.equal(input, '/api/chat')
    return serverResponse
  }) as typeof fetch
  globalThis.requestAnimationFrame = (() => 1) as typeof requestAnimationFrame
  globalThis.cancelAnimationFrame = (() => undefined) as typeof cancelAnimationFrame
  t.after(() => {
    globalThis.fetch = originalFetch
    globalThis.requestAnimationFrame = originalRequestAnimationFrame
    globalThis.cancelAnimationFrame = originalCancelAnimationFrame
  })

  let conversations: Conversation[] = [{
    id: conversationId,
    title: 'test',
    excerpt: '',
    date: '今日',
    messages: [{ id: assistantMessageId, role: 'assistant', content: '', thinking: '', time: '此刻' }],
  }]
  let memories: never[] = []
  const generationPatches: Array<{ status: string }> = []
  const setConversations = ((action: typeof conversations | ((value: typeof conversations) => typeof conversations)) => {
    conversations = typeof action === 'function' ? action(conversations) : action
  }) as Parameters<typeof runChatStream>[0]['setConversations']
  const setMemories = ((action: typeof memories | ((value: typeof memories) => typeof memories)) => {
    memories = typeof action === 'function' ? action(memories) : action
  }) as Parameters<typeof runChatStream>[0]['setMemories']

  const reply = await runChatStream({
    userId: USER_ID,
    messages: [{ role: 'user', content: 'hello' }],
    assistantMessageId,
    conversationId,
    controller: new AbortController(),
    generationId,
    tier: '绝句',
    endpoint: null,
    endpointId: null,
    memories: [],
    memoryEnabled: false,
    searchMode: 'off',
    deepResearch: false,
    historyRetrieval: false,
    setConversations,
    setMemories,
    markGeneration: (_id, patch) => { generationPatches.push(patch) },
    clearAbort: () => undefined,
  })

  const assistant = conversations[0]?.messages[0]
  assert.deepEqual(reply, { content: '', status: 'cancelled' })
  assert.equal(assistant?.content, 'database-prefix')
  assert.equal(assistant?.thinking, 'database-thinking')
  assert.equal(assistant?.content.includes('local-completion-that-lost'), false)
  assert.equal(assistant?.isError, undefined)
  assert.equal(assistant?.media, undefined)
  assert.equal(orphanCleanups, 1)
  assert.equal(generationPatches.at(-1)?.status, 'cancelled')
})

test('metadata stream without an authoritative terminal fails closed', async t => {
  const generationId = '10000000-0000-4000-8000-000000000011'
  const assistantMessageId = '20000000-0000-4000-8000-000000000011'
  const conversationId = '30000000-0000-4000-8000-000000000011'
  const raw = [
    `data: ${JSON.stringify({ generationId, assistantMessageId })}\n\n`,
    `data: ${JSON.stringify({ media: { type: 'image', url: 'data:image/png;base64,bG9zdA==' } })}\n\n`,
    `data: ${JSON.stringify({ text: 'unconfirmed local output' })}\n\n`,
    'data: [DONE]\n\n',
  ].join('')
  const originalFetch = globalThis.fetch
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame
  globalThis.fetch = (async () => new Response(raw, {
    headers: { 'Content-Type': 'text/event-stream' },
  })) as typeof fetch
  globalThis.requestAnimationFrame = (() => 1) as typeof requestAnimationFrame
  globalThis.cancelAnimationFrame = (() => undefined) as typeof cancelAnimationFrame
  t.after(() => {
    globalThis.fetch = originalFetch
    globalThis.requestAnimationFrame = originalRequestAnimationFrame
    globalThis.cancelAnimationFrame = originalCancelAnimationFrame
  })

  let conversations: Conversation[] = [{
    id: conversationId,
    title: 'test',
    excerpt: '',
    date: '今日',
    messages: [{ id: assistantMessageId, role: 'assistant', content: '', thinking: '', time: '此刻' }],
  }]
  let memories: never[] = []
  const statuses: string[] = []
  const setConversations = ((action: typeof conversations | ((value: typeof conversations) => typeof conversations)) => {
    conversations = typeof action === 'function' ? action(conversations) : action
  }) as Parameters<typeof runChatStream>[0]['setConversations']
  const setMemories = ((action: typeof memories | ((value: typeof memories) => typeof memories)) => {
    memories = typeof action === 'function' ? action(memories) : action
  }) as Parameters<typeof runChatStream>[0]['setMemories']

  const result = await runChatStream({
    userId: USER_ID,
    messages: [{ role: 'user', content: 'hello' }],
    assistantMessageId,
    conversationId,
    controller: new AbortController(),
    generationId,
    tier: '绝句',
    endpoint: null,
    endpointId: null,
    memories: [],
    memoryEnabled: false,
    searchMode: 'off',
    deepResearch: false,
    historyRetrieval: false,
    setConversations,
    setMemories,
    markGeneration: (_id, patch) => { statuses.push(patch.status) },
    clearAbort: () => undefined,
  })

  const assistant = conversations[0]?.messages[0]
  assert.deepEqual(result, { content: '', status: 'error' })
  assert.equal(assistant?.content, '生成终态尚未确认，请重新载入会话')
  assert.equal(assistant?.media, undefined)
  assert.equal(assistant?.isError, true)
  assert.equal(statuses.at(-1), 'error')
})
