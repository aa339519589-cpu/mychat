import assert from 'node:assert/strict'
import test from 'node:test'
import { createMediaGenerationResponse } from '../lib/chat/media-response'
import { createDatabaseGenerationStream } from '../lib/generation/db-stream'
import type { GenerationDatabaseRow } from '../lib/generation/types'
import { MediaGenerationError } from '../lib/llm/media-generation'

function ssePayloads(raw: string): unknown[] {
  return raw.split('\n')
    .filter(line => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map(line => JSON.parse(line.slice('data: '.length)))
}

test('media response emits thinking, media, success and terminal event', async () => {
  const response = await createMediaGenerationResponse({
    requestSignal: new AbortController().signal,
    durable: {
      supabase: null,
      userId: null,
      generationId: '10000000-0000-4000-8000-000000000001',
      conversationId: '20000000-0000-4000-8000-000000000001',
      assistantMessageId: '30000000-0000-4000-8000-000000000001',
    },
    baseUrl: 'https://media.example/v1',
    apiKey: 'secret',
    authType: 'bearer',
    model: 'image-model',
    outputKind: 'image',
    prompt: 'a circle',
    thinking: '正在生成……',
    successText: '图片已生成。',
    generateMedia: async options => {
      assert.equal(options.signal?.aborted, false)
      assert.equal(options.prompt, 'a circle')
      return { type: 'image', url: 'data:image/png;base64,cG5n' }
    },
  })

  const raw = await response.text()
  assert.deepEqual(ssePayloads(raw), [
    {
      generationId: '10000000-0000-4000-8000-000000000001',
      assistantMessageId: '30000000-0000-4000-8000-000000000001',
    },
    { thinking: '正在生成……' },
    { media: { type: 'image', url: 'data:image/png;base64,cG5n' } },
    { text: '图片已生成。' },
    {
      terminal: {
        status: 'completed',
        content: '图片已生成。',
        thinking: '正在生成……',
        sequence: 2,
        error: null,
        media: [{ type: 'image', url: 'data:image/png;base64,cG5n' }],
      },
    },
  ])
  assert.match(raw, /data: \[DONE\]\n\n$/)
})

test('media response preserves platform permission guidance', async () => {
  const response = await createMediaGenerationResponse({
    requestSignal: new AbortController().signal,
    durable: {
      supabase: null,
      userId: null,
      generationId: '10000000-0000-4000-8000-000000000002',
      conversationId: '20000000-0000-4000-8000-000000000002',
      assistantMessageId: '30000000-0000-4000-8000-000000000002',
    },
    baseUrl: 'https://media.example/v1',
    apiKey: 'secret',
    authType: 'bearer',
    model: 'image-model',
    outputKind: 'image',
    prompt: 'a circle',
    thinking: '正在生成……',
    successText: '图片已生成。',
    permissionError: '请为当前 Key 开启图片权限。',
    generateMedia: async () => {
      throw new MediaGenerationError('permission denied', 'permission_denied', 403)
    },
  })

  assert.deepEqual(ssePayloads(await response.text()), [
    {
      generationId: '10000000-0000-4000-8000-000000000002',
      assistantMessageId: '30000000-0000-4000-8000-000000000002',
    },
    { thinking: '正在生成……' },
    {
      terminal: {
        status: 'failed',
        content: '',
        thinking: '正在生成……',
        sequence: 1,
        error: '请为当前 Key 开启图片权限。',
        media: [],
      },
    },
  ])
})

test('media claim loser returns before invoking the expensive provider', async () => {
  let providerCalls = 0
  const response = await createMediaGenerationResponse({
    requestSignal: new AbortController().signal,
    durable: {
      supabase: {} as never,
      userId: '40000000-0000-4000-8000-000000000001',
      generationId: '10000000-0000-4000-8000-000000000003',
      conversationId: '20000000-0000-4000-8000-000000000003',
      assistantMessageId: '30000000-0000-4000-8000-000000000003',
    },
    baseUrl: 'https://media.example/v1',
    apiKey: 'secret',
    authType: 'bearer',
    model: 'image-model',
    outputKind: 'image',
    prompt: 'a circle',
    thinking: '正在生成……',
    successText: '图片已生成。',
    generateMedia: async () => {
      providerCalls += 1
      return { type: 'image', url: 'data:image/png;base64,cG5n' }
    },
    runnerDependencies: {
      getGeneration: () => undefined,
      claimGenerationLease: async () => ({
        ok: true,
        acquired: false,
        status: 'running',
        reason: 'active',
        media: [],
      }),
    },
  })

  assert.equal(response.status, 409)
  assert.equal(providerCalls, 0)
})

test('client disconnect does not abort an already claimed media job', async () => {
  const requestController = new AbortController()
  let releaseProvider!: () => void
  const providerRelease = new Promise<void>(resolve => { releaseProvider = resolve })
  let providerStarted!: (signal: AbortSignal | undefined) => void
  const started = new Promise<AbortSignal | undefined>(resolve => { providerStarted = resolve })
  let finalized!: () => void
  const finalization = new Promise<void>(resolve => { finalized = resolve })

  const response = await createMediaGenerationResponse({
    requestSignal: requestController.signal,
    durable: {
      supabase: null,
      userId: null,
      generationId: '10000000-0000-4000-8000-000000000004',
      conversationId: '20000000-0000-4000-8000-000000000004',
      assistantMessageId: '30000000-0000-4000-8000-000000000004',
    },
    baseUrl: 'https://media.example/v1',
    apiKey: 'secret',
    authType: 'bearer',
    model: 'video-model',
    outputKind: 'video',
    prompt: 'a durable video',
    thinking: '正在生成……',
    successText: '视频已生成。',
    generateMedia: async options => {
      providerStarted(options.signal)
      await providerRelease
      return { type: 'video', url: 'data:video/mp4;base64,dmlkZW8=' }
    },
    runnerDependencies: {
      maybeGc: () => { finalized() },
    },
  })

  const providerSignal = await started
  requestController.abort()
  assert.equal(providerSignal?.aborted, false)
  releaseProvider()
  await finalization
  assert.equal(providerSignal?.aborted, false)
  await response.body?.cancel()
})

test('durable media flows claim to storage to terminal CAS and database resume', async () => {
  const userId = '40000000-0000-4000-8000-000000000010'
  const generationId = '10000000-0000-4000-8000-000000000010'
  const conversationId = '20000000-0000-4000-8000-000000000010'
  const assistantMessageId = '30000000-0000-4000-8000-000000000010'
  const durableUrl = `https://project.supabase.co/storage/v1/object/public/generated-media/${userId}/${conversationId}/${generationId}/asset.png`
  let providerCalls = 0
  let finalizeMedia: unknown
  let cleanupCalls = 0
  const response = await createMediaGenerationResponse({
    requestSignal: new AbortController().signal,
    durable: {
      supabase: {} as never,
      userId,
      generationId,
      conversationId,
      assistantMessageId,
    },
    baseUrl: 'https://provider.example/v1',
    apiKey: 'provider-secret',
    authType: 'bearer',
    model: 'image-model',
    outputKind: 'image',
    prompt: 'durable image',
    thinking: '正在生成……',
    successText: '图片已生成。',
    generateMedia: async () => {
      providerCalls += 1
      return { type: 'image', url: 'data:image/png;base64,AQID', mimeType: 'image/png' }
    },
    persistMedia: async (context, media) => {
      assert.equal(context.userId, userId)
      assert.equal(context.conversationId, conversationId)
      assert.equal(context.generationId, generationId)
      assert.match(media.url, /^data:image\/png/)
      return {
        media: { type: 'image', url: durableUrl, mimeType: 'image/png' },
        receipt: {
          bucket: 'generated-media',
          objectKey: `${userId}/${conversationId}/${generationId}/asset.png`,
        },
      }
    },
    cleanupMedia: async () => { cleanupCalls += 1 },
    runnerDependencies: {
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
      persistGenerationProgress: async () => ({
        ok: true, accepted: true, status: 'running', media: [],
      }),
      renewGenerationLease: async () => 'renewed',
      loadGenerationStatusFromDb: async () => ({ kind: 'found', value: 'running' }),
      finalizeGenerationLease: async input => {
        finalizeMedia = input.media
        return {
          ok: true,
          accepted: true,
          status: 'completed',
          content: input.content,
          thinking: input.thinking,
          sequence: input.sequence,
          media: input.media ?? [],
        }
      },
      maybeGc: () => undefined,
    },
  })

  const raw = await response.text()
  assert.equal(providerCalls, 1)
  assert.equal(cleanupCalls, 0)
  assert.deepEqual(finalizeMedia, [{ type: 'image', url: durableUrl, mimeType: 'image/png' }])
  assert.equal(raw.includes('data:image/png'), false)
  assert.equal(raw.includes(durableUrl), true)

  const row: GenerationDatabaseRow = {
    id: generationId,
    user_id: userId,
    conversation_id: conversationId,
    assistant_message_id: assistantMessageId,
    status: 'completed',
    content: '图片已生成。',
    thinking: '正在生成……',
    sequence: 2,
    error: null,
    media: finalizeMedia as GenerationDatabaseRow['media'],
  }
  const resumed = ssePayloads(await new Response(createDatabaseGenerationStream(
    row,
    async () => ({ kind: 'found', value: row }),
  )).text())
  assert.deepEqual((resumed[0] as { media: unknown }).media, finalizeMedia)
})

test('cancel-winning media CAS emits no media and cleans the uploaded object', async () => {
  const userId = '40000000-0000-4000-8000-000000000011'
  const generationId = '10000000-0000-4000-8000-000000000011'
  const conversationId = '20000000-0000-4000-8000-000000000011'
  const assistantMessageId = '30000000-0000-4000-8000-000000000011'
  const objectKey = `${userId}/${conversationId}/${generationId}/asset.png`
  const durableUrl = `https://project.supabase.co/storage/v1/object/public/generated-media/${objectKey}`
  const cleaned: string[] = []
  const response = await createMediaGenerationResponse({
    requestSignal: new AbortController().signal,
    durable: { supabase: {} as never, userId, generationId, conversationId, assistantMessageId },
    baseUrl: 'https://provider.example/v1',
    apiKey: 'secret',
    authType: 'bearer',
    model: 'image-model',
    outputKind: 'image',
    prompt: 'cancel race',
    thinking: '正在生成……',
    successText: '图片已生成。',
    generateMedia: async () => ({
      type: 'image', url: 'data:image/png;base64,AQID', mimeType: 'image/png',
    }),
    persistMedia: async () => ({
      media: { type: 'image', url: durableUrl, mimeType: 'image/png' },
      receipt: { bucket: 'generated-media', objectKey },
    }),
    cleanupMedia: async (_scope, receipts) => {
      cleaned.push(...receipts.map(receipt => receipt.objectKey))
    },
    runnerDependencies: {
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
      persistGenerationProgress: async () => ({
        ok: true, accepted: true, status: 'running', media: [],
      }),
      renewGenerationLease: async () => 'renewed',
      loadGenerationStatusFromDb: async () => ({ kind: 'found', value: 'running' }),
      finalizeGenerationLease: async () => ({
        ok: true,
        accepted: false,
        status: 'cancelled',
        content: '',
        thinking: '正在生成……',
        sequence: 3,
        media: [],
      }),
      maybeGc: () => undefined,
    },
  })

  const payloads = ssePayloads(await response.text()) as Array<Record<string, unknown>>
  assert.deepEqual(cleaned, [objectKey])
  assert.equal(payloads.some(payload => 'media' in payload), false)
  assert.deepEqual(payloads.at(-1), {
    terminal: {
      status: 'cancelled',
      content: '',
      thinking: '正在生成……',
      sequence: 3,
      error: null,
      media: [],
    },
  })
})
