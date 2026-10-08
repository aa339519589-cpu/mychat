import assert from 'node:assert/strict'
import test from 'node:test'
import type { SupabaseClient } from '../lib/supabase/types'
import type { AgentLoopOpts } from '../lib/llm/agent-loop'
import { customModelCapability } from '../lib/llm/models'
import type { JobAccounting } from '../lib/jobs/repository'
import type { JobEventDraft, JsonObject } from '../lib/jobs/contracts'
import { JobRuntimeError } from '../lib/jobs/errors'
import { JobEventWriter } from '../lib/jobs/event-writer'
import type { JobExecutionContext } from '../lib/jobs/worker'
import type { LoadedChatJob } from '../lib/jobs/handlers/chat-input'
import {
  runChatTextJob,
  type ChatTextDependencies,
} from '../lib/jobs/handlers/chat-text'

function chatTestSupabase() {
  const query = {
    select() { return query },
    eq() { return query },
    in() { return query },
    async order() { return { data: [], error: null } },
  }
  return { from: () => query } as unknown as SupabaseClient
}

function chatInput(): LoadedChatJob {
  return {
    client: chatTestSupabase(),
    userId: '10000000-0000-4000-8000-000000000001',
    conversationId: '20000000-0000-4000-8000-000000000001',
    userMessageId: '30000000-0000-4000-8000-000000000001',
    assistantMessageId: '40000000-0000-4000-8000-000000000001',
    command: {
      tier: '绝句',
      searchMode: 'off',
      deepResearch: false,
      historyRetrieval: false,
      connectorAccessMode: 'always_available',
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

test('a greeting retains conversation, user instructions, thinking and normal output budget', async () => {
  const context = executionContext()
  const input = chatInput()
  input.context.messages = [{ role: 'user', content: '我的名字叫 Jim' },
    { role: 'assistant', content: '记住了' }, { role: 'user', content: '你好' }]
  input.context.customSystemPrompt = '使用正式语气'
  input.selection.thinking = true
  input.selection.reasoningEffort = 'high'
  let historyPrepared = false
  const result = await runChatTextJob(context.value, input, {
    ...baseDependencies(async options => {
      assert.equal(options.thinking, true)
      assert.equal(options.reasoningEffort, 'high')
      assert.ok((options.turnOptions?.maxOutputTokens ?? 0) >= 10_000)
      assert.ok(JSON.stringify(options.messages).includes('我的名字叫 Jim'))
      assert.ok(JSON.stringify(options.messages).includes('使用正式语气'))
      assert.doesNotMatch(JSON.stringify(options.messages), /只是简短问候|自然回复一到两句/)
      options.emit({ text: '你好，Jim。' })
      return { totalTokens: 0 }
    }),
    prepareHistory: async () => { historyPrepared = true; return { conversationId: input.conversationId, renderedContext: '' } },
  })
  assert.equal(historyPrepared, true)
  assert.equal(result.status, 'completed')
})

test('chat history index is atomically scheduled with completion instead of delaying model output or terminal', async () => {
  const context = executionContext()
  const input = chatInput()
  input.command.historyRetrieval = true
  input.context.messages = [{ role: 'user', content: '哈哈哈' }]
  let historyDeferred = false
  const result = await runChatTextJob(context.value, input, {
    ...baseDependencies(async options => {
      options.emit({ text: '哈哈 😄' })
      return { totalTokens: 0 }
    }),
    prepareHistory: async options => {
      historyDeferred = options.deferIndexing === true
      return { conversationId: input.conversationId, renderedContext: '' }
    },
  })
  assert.equal(historyDeferred, true)
  assert.equal(result.status, 'completed')
  if (result.status !== 'completed') return
  assert.deepEqual(result.outbox, [{
    kind: 'history.index', dedupeKey: `${context.value.job.id}:history-index`,
    payload: { conversationId: input.conversationId },
  }])
  assert.ok(context.events.some(event => event.kind === 'text.delta'))
  assert.ok(context.events.some(event => event.kind === 'model.output_completed'))
})

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
  assert.ok(context.events.some(event => event.kind === 'model.output_completed'))
  assert.ok(
    context.events.findIndex(event => event.kind === 'text.delta')
      < context.events.findIndex(event => event.kind === 'model.output_completed'),
  )
})

test('chat text Job publishes retrieved history citations as a search trace', async () => {
  const context = executionContext()
  const input = chatInput()
  input.context = {
    ...input.context,
    messages: [{
      id: '30000000-0000-4000-8000-000000000001',
      role: 'user',
      content: 'What did I say about coffee?',
    }],
  }
  const result = await runChatTextJob(context.value, input, {
    ...baseDependencies(async options => {
      options.emit({ text: 'answer' })
      options.messages.push({ role: 'assistant', content: 'answer' })
      return { totalTokens: 0 }
    }),
    prepareHistory: async () => ({
      conversationId: 'current-conversation',
      renderedContext: '\nHISTORY',
      query: '咖啡',
      sources: [{
        conversationId: 'history-conversation',
        conversationTitle: 'Coffee notes',
        messageStartId: 'history-message',
        snippet: '用户喜欢手冲咖啡',
        createdAt: '2026-07-13T00:00:00.000Z',
      }],
    }),
  })

  assert.equal(result.status, 'completed')
  const event = context.events.find(item => item.kind === 'tool.search')
  const payload = event?.payload.search
  assert.ok(payload && typeof payload === 'object' && !Array.isArray(payload))
  const search = payload as unknown as {
    kind?: unknown
    results?: Array<{ conversation_id?: unknown; url?: unknown }>
  }
  assert.equal(search.kind, 'history')
  assert.equal(search.results?.[0]?.conversation_id, 'history-conversation')
  assert.match(String(search.results?.[0]?.url ?? ''), /^mychat:\/\/conversation\//)
})

test('custom chat models receive enabled global memories and memory tools', async () => {
  const context = executionContext()
  const input = chatInput()
  input.context = {
    ...input.context,
    messages: [{
      id: '30000000-0000-4000-8000-000000000001',
      role: 'user',
      content: 'Please explain how my saved preferences should affect future answers.',
    }],
    memories: [{
      id: '70000000-0000-4000-8000-000000000001',
      content: '用户偏好简洁、清晰的中文回答。',
      timestamp: '2026-10-01T00:00:00.000Z',
    }],
    memoryEnabled: true,
  }
  let captured: AgentLoopOpts | undefined

  await runChatTextJob(context.value, input, baseDependencies(async options => {
    captured = options
    return { totalTokens: 0 }
  }))

  const system = captured?.messages[0]?.content
  assert.equal(typeof system, 'string')
  assert.match(system as string, /当前用户已经开启 Memory/)
  assert.match(system as string, /用户偏好简洁、清晰的中文回答/)
  const toolNames = (captured?.tools ?? []).map(tool => {
    const definition = tool.function as { name?: string } | undefined
    return definition?.name
  })
  assert.ok(toolNames.includes('remember'))
  assert.ok(toolNames.includes('update_memory'))
  assert.ok(toolNames.includes('forget'))
})

test('custom project chats receive enabled project memories and project memory tools', async () => {
  const context = executionContext()
  const input = chatInput()
  input.context = {
    ...input.context,
    memories: [],
    memoryEnabled: true,
    project: {
      id: '70000000-0000-4000-8000-000000000002',
      instructions: '',
      files: [],
      projectMemories: [{
        id: '70000000-0000-4000-8000-000000000003',
        content: '项目规定先运行回归测试。',
      }],
    },
  }
  let captured: AgentLoopOpts | undefined

  await runChatTextJob(context.value, input, baseDependencies(async options => {
    captured = options
    return { totalTokens: 0 }
  }))

  const system = captured?.messages[0]?.content
  assert.equal(typeof system, 'string')
  assert.match(system as string, /项目规定先运行回归测试/)
  assert.ok((system as string).includes('用户询问本项目记忆中明确记录的信息时，必须直接依据对应记忆作答'))
  assert.ok((system as string).includes('不得声称不知道、臆测或用全局记忆替代'))
  const toolNames = (captured?.tools ?? []).map(tool => {
    const definition = tool.function as { name?: string } | undefined
    return definition?.name
  })
  assert.ok(toolNames.includes('remember_project'))
  assert.ok(toolNames.includes('update_project_memory'))
  assert.ok(toolNames.includes('forget_project'))
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


test('chat generation retains the preparing relay through its first text and terminal snapshot', async () => {
  const context = executionContext()
  const input = chatInput()
  const live: Array<{ kind: string; offset?: number }> = []
  const writer = new JobEventWriter(context.value, event => { live.push(event) })
  await writer.append('job.started', { phase: 'preparing' })
  const result = await runChatTextJob(context.value, input, {
    ...baseDependencies(async options => {
      options.emit({ text: '你' })
      options.emit({ text: '好' })
      return { totalTokens: 0 }
    }),
  }, writer)
  assert.equal(result.status, 'completed')
  assert.equal(writer.text(), '你好')
  assert.deepEqual(live.filter(event => event.kind === 'text.delta').map(event => event.offset), [0, 1])
  assert.equal(live[0].kind, 'job.started')
  assert.ok(live.some(event => event.kind === 'model.output_completed'))
})
