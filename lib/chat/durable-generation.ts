import { addQuotaUsage } from '@/lib/quota'
import type { SearchMode } from '@/lib/search-mode'
import { latestBeijingDateFromMessages } from '@/lib/search-mode'
import {
  appendText,
  appendThinking,
  createGeneration,
  getAbortSignal,
  getGeneration,
  maybeGc,
  setStatus,
} from '@/lib/generation/runtime'
import { persistAssistantMessage, persistGenerationRow } from '@/lib/generation/persist'
import { runAgentLoop, type AgentLoopOpts, type ExecuteTool } from '@/lib/llm/agent-loop'
import type { ChatRequestBody } from '@/lib/llm/chat-request'
import { buildModelContext } from '@/lib/llm/context'
import type { ChatEvent, Emit } from '@/lib/llm/events'
import { ensureImageSummaries } from '@/lib/llm/image-context'
import { chatCompletionsUrl, injectAttachmentsOpenAI } from '@/lib/llm/openai'
import { done, networkError, send } from '@/lib/llm/stream'
import { buildSystem } from '@/lib/llm/system'
import { log } from '@/lib/logger'
import { activeTools, execTool, toOpenAITools, type ToolContext } from '@/lib/tools'
import { ocrScannedPdfs } from './attachments'
import { prepareChatHistory, RECENT_CONTEXT_MESSAGES } from './history'
import type { ChatModelSelection } from './model-selection'
import { prependDeepResearchInstruction, resolveReasoningEffort } from './request-context'

const SAFETY_ROUNDS = 16
const HEARTBEAT_INTERVAL_MS = 8_000
const PERSIST_INTERVAL_MS = 1_000
const PERSIST_THROTTLE_MS = 800

type GenerationMetadata = { generationId: string; assistantMessageId: string }
type StreamEvent = ChatEvent | { heartbeat: true } | GenerationMetadata

type DurableChatDependencies = {
  runAgentLoop: (options: AgentLoopOpts) => Promise<{ totalTokens: number }>
  createGeneration: typeof createGeneration
  appendText: typeof appendText
  appendThinking: typeof appendThinking
  getAbortSignal: typeof getAbortSignal
  getGeneration: typeof getGeneration
  setStatus: typeof setStatus
  maybeGc: typeof maybeGc
  persistAssistantMessage: typeof persistAssistantMessage
  persistGenerationRow: typeof persistGenerationRow
  addQuotaUsage: typeof addQuotaUsage
}

const DEFAULT_DEPENDENCIES: DurableChatDependencies = {
  runAgentLoop,
  createGeneration,
  appendText,
  appendThinking,
  getAbortSignal,
  getGeneration,
  setStatus,
  maybeGc,
  persistAssistantMessage,
  persistGenerationRow,
  addQuotaUsage,
}

export type DurableChatGenerationOptions = {
  requestSignal: AbortSignal
  auth: {
    supabase: Parameters<typeof prepareChatHistory>[0]['supabase']
    userId: string | null
  }
  body: ChatRequestBody
  selection: ChatModelSelection
  memoryEnabled: boolean
  usingBalance: boolean
  searchMode: SearchMode
  hasScannedAttachment: boolean
}

export function createDurableChatGenerationResponse(
  options: DurableChatGenerationOptions,
  overrides: Partial<DurableChatDependencies> = {},
): Response {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides }
  const { requestSignal, auth, body, selection } = options
  const { supabase, userId } = auth
  const {
    tier = '绝句',
    messages,
    memories,
    attachments,
    deepResearch,
    project,
    conversationId,
    historyRetrieval,
  } = body
  const {
    customEndpoint,
    model,
    thinking,
    capability,
    apiKey,
    authType,
    endpointDisplayName,
    platformTierLabel,
  } = selection

  const generationId = body.generationId || crypto.randomUUID()
  const assistantId = body.assistantMessageId || crypto.randomUUID()
  const generationConversationId = conversationId || 'unknown'
  if (userId) {
    dependencies.createGeneration({
      id: generationId,
      userId,
      conversationId: generationConversationId,
      assistantMessageId: assistantId,
    })
    dependencies.setStatus(generationId, 'running')
  }
  const generationSignal = dependencies.getAbortSignal(generationId)
  const latestBeijingDate = latestBeijingDateFromMessages(messages)
  const tools = activeTools({
    loggedIn: Boolean(userId),
    searchMode: options.searchMode,
    memoryEnabled: customEndpoint ? false : options.memoryEnabled,
    projectId: customEndpoint ? null : (project?.id ?? null),
  })
  const toolContext: ToolContext = {
    supabase,
    userId,
    projectId: project?.id ?? null,
    searchMode: options.searchMode,
    latestBeijingDate,
    signal: generationSignal,
  }
  const effectiveMemories = !customEndpoint && options.memoryEnabled && !project?.id
    ? memories
    : undefined
  const recentMessages = messages.slice(-RECENT_CONTEXT_MESSAGES)
  const isDeepTierProxy = capability.provider.id === 'deep-tier'
  const reasoningEffort = resolveReasoningEffort({
    isDeepTierProxy,
    deepResearch: Boolean(deepResearch),
    modelId: model,
  })
  if (reasoningEffort) {
    log.info('chat', 'reasoning effort', {
      model,
      reasoningEffort,
      deepResearch: Boolean(deepResearch),
      adapter: capability.provider.adapter,
    })
  }

  let clientConnected = true
  requestSignal.addEventListener('abort', () => {
    clientConnected = false
    log.info('generation', 'stream disconnected (client)', {
      generationId,
      conversationId: generationConversationId,
      assistantMessageId: assistantId,
    })
  }, { once: true })

  const stream = new ReadableStream({
    async start(controller) {
      const safeSend = (event: StreamEvent) => {
        if (!clientConnected) return
        try { send(controller, event) } catch { clientConnected = false }
      }
      const emit: Emit = event => {
        if ('text' in event) dependencies.appendText(generationId, event.text)
        if ('thinking' in event) dependencies.appendThinking(generationId, event.thinking)
        safeSend(event)
      }
      let totalTokensUsed = 0
      let lastPersistAt = 0
      const persistProgress = async (force = false) => {
        if (!supabase || !userId) return
        const entry = dependencies.getGeneration(generationId)
        if (!entry) return
        const now = Date.now()
        if (!force && now - lastPersistAt < PERSIST_THROTTLE_MS) return
        lastPersistAt = now
        await dependencies.persistAssistantMessage(supabase as any, assistantId, {
          content: entry.record.content,
          thinking: entry.record.thinking || null,
        })
        await dependencies.persistGenerationRow(supabase as any, {
          id: entry.record.id,
          userId: entry.record.userId,
          conversationId: entry.record.conversationId,
          assistantMessageId: entry.record.assistantMessageId,
          status: entry.record.status,
          content: entry.record.content,
          thinking: entry.record.thinking,
          sequence: entry.record.sequence,
          error: entry.record.error,
        })
      }

      safeSend({ heartbeat: true })
      safeSend({ generationId, assistantMessageId: assistantId })
      const heartbeat = setInterval(() => safeSend({ heartbeat: true }), HEARTBEAT_INTERVAL_MS)
      const persistTimer = setInterval(() => { void persistProgress(false) }, PERSIST_INTERVAL_MS)
      const executeTool: ExecuteTool = async (name, input) => {
        const { result, event } = await execTool(tools, name, input, toolContext)
        if (event) emit(event as ChatEvent)
        return result
      }

      try {
        const historyContext = await prepareChatHistory({
          supabase,
          userId,
          conversationId,
          messages,
          projectId: project?.id ?? null,
          tier: String(tier),
          historyRetrievalEnabled: historyRetrieval === true,
          customEndpoint,
          signal: generationSignal,
        })
        const system = buildSystem(effectiveMemories, {
          searchMode: options.searchMode,
          latestBeijingDate,
          memoryEnabled: customEndpoint ? false : options.memoryEnabled,
          project: customEndpoint ? undefined : project,
          modelSource: customEndpoint ? 'custom' : 'platform',
          tierLabel: customEndpoint ? null : platformTierLabel,
          modelId: customEndpoint ? model : null,
          endpointName: customEndpoint ? endpointDisplayName : null,
        }) + historyContext.renderedContext
        const preparedMessages = customEndpoint || capability.supportsImageInput
          ? recentMessages
          : await ensureImageSummaries(recentMessages, { supabase, userId, emit, signal: generationSignal })
        const modelMessages: any[] = [
          { role: 'system', content: system },
          ...buildModelContext(preparedMessages, capability),
        ]
        if (deepResearch) prependDeepResearchInstruction(modelMessages)
        if (!customEndpoint && options.hasScannedAttachment) {
          emit({ thinking: '正在识别扫描件内容，请稍候……' })
        }
        const processedAttachments = await ocrScannedPdfs(attachments, generationSignal)
        await injectAttachmentsOpenAI(modelMessages, processedAttachments)
        log.info('generation', 'stream connected', {
          generationId,
          conversationId: generationConversationId,
          assistantMessageId: assistantId,
          status: 'running',
        })
        await dependencies.runAgentLoop({
          url: chatCompletionsUrl(capability.provider.baseUrl),
          apiKey,
          model,
          adapter: capability.provider.adapter,
          thinking,
          reasoningEffort,
          messages: modelMessages,
          tools: toOpenAITools(tools),
          emit,
          executeTool,
          maxRounds: SAFETY_ROUNDS,
          leakedRetry: true,
          autoContinue: { maxContinuations: 4 },
          onUsage: total => { totalTokensUsed = total },
          turnOptions: {
            signal: generationSignal,
            timeoutMs: 120_000,
            authType,
            logTiming: isDeepTierProxy || process.env.DEBUG_LLM_TIMING === '1',
          },
          onTurn: ({ phase, round, turn }) => log.info('chat', `Turn ${phase}`, {
            round,
            finishReason: turn.finishReason,
            leaked: turn.leaked,
            toolCalls: turn.toolCalls.length,
            contentLen: turn.content.length,
            truncated: turn.truncated,
          }),
        })
        dependencies.setStatus(generationId, generationSignal?.aborted ? 'cancelled' : 'completed')
      } catch (error) {
        const message = networkError(error, '模型服务', [apiKey])
        if (generationSignal?.aborted) {
          dependencies.setStatus(generationId, 'cancelled')
        } else {
          dependencies.setStatus(generationId, 'failed', message)
          emit({ error: message })
        }
      } finally {
        clearInterval(heartbeat)
        clearInterval(persistTimer)
        await persistProgress(true)
        if (!customEndpoint && userId && supabase) {
          await dependencies.addQuotaUsage(
            supabase,
            userId,
            totalTokensUsed,
            model,
            thinking,
            options.usingBalance,
          )
        }
        if (clientConnected) {
          try { done(controller) } catch { clientConnected = false }
        }
        dependencies.maybeGc(generationId)
      }
    },
    cancel() {
      clientConnected = false
    },
  })

  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
  })
}
