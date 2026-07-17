import assert from 'node:assert/strict'
import test from 'node:test'
import type { SupabaseClient } from '../lib/supabase/types'
import type { AgentLoopOpts } from '../lib/llm/agent-loop'
import { customModelCapability } from '../lib/llm/models'
import type { JobAccounting } from '../lib/jobs/repository'
import type { JobEventDraft, JsonObject } from '../lib/jobs/contracts'
import { JobRuntimeError } from '../lib/jobs/errors'
import type { JobExecutionContext } from '../lib/jobs/worker'
import type { LoadedChatJob } from '../lib/jobs/handlers/chat-input'
import {
  runChatTextJob,
  type ChatTextDependencies,
} from '../lib/jobs/handlers/chat-text'

function chatInput(): LoadedChatJob {
  return {
    client: {} as SupabaseClient,
    userId: '10000000-0000-4000-8000-000000000001',
    conversationId: '20000000-0000-4000-8000-000000000001',
    userMessageId: '30000000-0000-4000-8000-000000000001',
    assistantMessageId: '40000000-0000-4000-8000-000000000001',
    command: {
      tier: '绝句',
      searchMode: 'off',
      deepResearch: false,
      historyRetrieval: false,
      usingBalance: false,
      outputKind: 'text',
      attachments: [],
    },
    context: {
      messages: [{
        id: '30000000-0000-4000-8000-000000000001',
        role: 'user',
        content: 'hello',
      }],
      memories: [],
      memoryEnabled: false,
      project: undefined,
    },
    selection: {
      customEndpoint: true,
      model: 'chat-model',
      thinking: false,
      capability: customModelCapability('chat-model', 'https://model.example/v1'),
      apiKey: 'test-key',
      authType: 'bearer',
      outputKind: 'chat',
    },
  } as unknown as LoadedChatJob
}

function executionContext(assertAuthority: () => void = () => {}) {
  const order: string[] = []
  const events: JobEventDraft[] = []
  const checkpoints: Array<{ phase: string; checkpoint: JsonObject; progress?: JsonObject }> = []
  const accounting: JobAccounting[] = []
  let toolCalls = 0
  const value = {
    job: {
      id: '50000000-0000-4000-8000-000000000001',
      type: 'chat.generation',
      attempt: 2,
      checkpoint: null,
      usage: {
        wallTimeMs: 0,
        rawTokens: 5,
        weightedTokens: 5,
        costMicros: 0,
        sandboxTimeMs: 0,
        toolCalls: 0,
      },
    },
    fence: {
      jobId: '50000000-0000-4000-8000-000000000001',
      workerId: 'worker-1',
      leaseVersion: 2,
    },
    signal: new AbortController().signal,
    budget: {
      consumeToolCall() { toolCalls++ },
    },
    assertAuthority,
    reportAccounting(entry: JobAccounting) {
      order.push('accounting.report')
      accounting.push(entry)
    },
    async flushAccounting() {
      order.push('accounting.flush')
    },
    async appendEvents(batch: readonly JobEventDraft[]) {
      order.push(`events:${batch.map(event => event.kind).join(',')}`)
      events.push(...batch)
    },
    async checkpoint(input: { phase: string; checkpoint: JsonObject; progress?: JsonObject }) {
      order.push('checkpoint')
      checkpoints.push(input)
    },
  } as unknown as JobExecutionContext
  return { value, order, events, checkpoints, accounting, toolCalls: () => toolCalls }
}

function baseDependencies(run: ChatTextDependencies['runAgentLoop']): Partial<ChatTextDependencies> {
  return {
    runAgentLoop: run,
    prepareHistory: async () => ({ conversationId: 'conversation', renderedContext: '\nHISTORY' }),
    ocrAttachments: async () => [],
    injectAttachments: async () => {},
  }
}

test('chat text Job flushes current-attempt accounting before writing its checkpoint', async () => {
  const context = executionContext()
  const captured: { modelOptions?: AgentLoopOpts } = {}
  const result = await runChatTextJob(context.value, chatInput(), baseDependencies(async options => {
    captured.modelOptions = options
    options.emit({ thinking: 'reasoning' })
    options.emit({ text: 'answer' })
    await options.onUsage?.(12)
    options.messages.push({ role: 'assistant', content: 'answer' })
    await options.onCheckpoint?.(options.messages)
    return { totalTokens: 12 }
  }))

  assert.equal(result.status, 'completed')
  assert.equal((result.result as { content?: string }).content, 'answer')
  assert.equal((result.result as { thinking?: string }).thinking, 'reasoning')
  assert.equal((result.result as { totalTokens?: number }).totalTokens, 17)
  assert.equal(result.ledgerEntries?.[0]?.rawTokens, 12)
  assert.equal(context.accounting[0]?.rawTokens, 12)
  assert.ok(context.order.indexOf('accounting.flush') < context.order.indexOf('checkpoint'))
  assert.equal(context.checkpoints[0]?.progress?.totalTokens, 17)
  assert.equal(captured.modelOptions?.turnOptions?.idempotencyNamespace, context.value.job.id)
  assert.ok(context.events.some(event => event.kind === 'job.started'))
  assert.ok(context.events.some(event => event.kind === 'text.delta'))
})

test('chat text Job rejects unsafe provider tool-call ids before recording an effect', async () => {
  const context = executionContext()
  let effectCalls = 0
  const dependencies: Partial<ChatTextDependencies> = {
    ...baseDependencies(async options => {
      await options.executeTool('web_search', { query: 'topic' }, { toolCallId: 'bad\nid' })
      return { totalTokens: 0 }
    }),
    executeToolEffect: async () => {
      effectCalls++
      return { result: '', replayed: false }
    },
  }

  await assert.rejects(
    runChatTextJob(context.value, chatInput(), dependencies),
    error => error instanceof JobRuntimeError && error.code === 'JOB_INVALID_INPUT',
  )
  assert.equal(context.toolCalls(), 1)
  assert.equal(effectCalls, 0)
})

test('chat text Job compensates durable media when authority is lost after upload', async () => {
  let uploaded = false
  let cleanupCalls = 0
  const context = executionContext(() => {
    if (uploaded) throw new Error('stale lease')
  })
  const dependencies: Partial<ChatTextDependencies> = {
    ...baseDependencies(async options => {
      options.emit({ media: { type: 'image', url: 'https://provider.example/image.png' } })
      return { totalTokens: 0 }
    }),
    persistMediaList: async () => {
      uploaded = true
      return {
        media: [{ type: 'image', url: '/api/v1/media/safe/content' }],
        receipts: [{ bucket: 'generated-media', objectKey: 'safe/object.png' }],
      }
    },
    cleanupMedia: async (_scope, receipts) => {
      cleanupCalls++
      assert.equal(receipts[0]?.objectKey, 'safe/object.png')
    },
  }

  await assert.rejects(
    runChatTextJob(context.value, chatInput(), dependencies),
    error => error instanceof JobRuntimeError && error.code === 'JOB_DEPENDENCY_UNAVAILABLE',
  )
  assert.equal(cleanupCalls, 1)
})
