import { addQuotaUsage } from '@/lib/quota'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  DEFAULT_DURABLE_RUNNER_DEPENDENCIES,
  initializeDurableGenerationRunner,
  type DurableRunnerDependencies,
} from '@/lib/generation/durable-runner'
import {
  terminalEventFromConfirmation,
  type TerminalPlan,
} from '@/lib/generation/terminal'
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
import {
  latestBeijingDateFromMessages,
  prependDeepResearchInstruction,
  resolveReasoningEffort,
  type SearchMode,
} from './request-context'
import {
  cleanupDurableGeneratedMediaUploads,
  DurableMediaStorageError,
  persistDurableGeneratedMediaList,
  type DurableMediaPersistenceBatch,
} from '@/lib/generation/media-storage'

const SAFETY_ROUNDS = 16
const HEARTBEAT_INTERVAL_MS = 8_000

type GenerationMetadata = { generationId: string; assistantMessageId: string }
type StreamEvent = ChatEvent | { heartbeat: true } | GenerationMetadata

type DurableChatDependencies = DurableRunnerDependencies & {
  runAgentLoop: (options: AgentLoopOpts) => Promise<{ totalTokens: number }>
  addQuotaUsage: typeof addQuotaUsage
  persistMediaList: typeof persistDurableGeneratedMediaList
  cleanupMedia: typeof cleanupDurableGeneratedMediaUploads
}

const DEFAULT_DEPENDENCIES: DurableChatDependencies = {
  ...DEFAULT_DURABLE_RUNNER_DEPENDENCIES,
  runAgentLoop,
  addQuotaUsage,
  persistMediaList: persistDurableGeneratedMediaList,
  cleanupMedia: cleanupDurableGeneratedMediaUploads,
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

export async function createDurableChatGenerationResponse(
  options: DurableChatGenerationOptions,
  overrides: Partial<DurableChatDependencies> = {},
): Promise<Response> {
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
  const initialized = await initializeDurableGenerationRunner({
    supabase: supabase as unknown as SupabaseClient | null,
    userId,
    generationId,
    conversationId,
    assistantMessageId: assistantId,
  }, dependencies)
  if (initialized.response) return initialized.response
  const runner = initialized.runner
  const generationSignal = runner.signal
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
      const pendingMedia: Array<Extract<ChatEvent, { media: unknown }>['media']> = []
      const emit: Emit = event => {
        if ('media' in event) {
          pendingMedia.push(event.media)
          return
        }
        if ('text' in event) runner.appendText(event.text)
        if ('thinking' in event) runner.appendThinking(event.thinking)
        safeSend(event)
      }
      let totalTokensUsed = 0
      // Claim already created the durable row before this stream was returned.
      await runner.start()
      safeSend({ heartbeat: true })
      safeSend({ generationId, assistantMessageId: assistantId })
      const heartbeat = setInterval(() => safeSend({ heartbeat: true }), HEARTBEAT_INTERVAL_MS)
      const executeTool: ExecuteTool = async (name, input) => {
        runner.assertAuthority()
        const { result, event } = await execTool(tools, name, input, toolContext)
        if (event) emit(event as ChatEvent)
        return result
      }

      let terminalPlan: TerminalPlan = { status: 'completed' }
      let persistedMedia: DurableMediaPersistenceBatch | null = null
      try {
        runner.assertAuthority()
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
        const modelMessages: AgentLoopOpts['messages'] = [
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
        await runner.observeRemoteTerminal()
        runner.assertAuthority()
        if (pendingMedia.length && supabase && userId && conversationId) {
          persistedMedia = await dependencies.persistMediaList({
            userId,
            conversationId,
            generationId,
            baseUrl: capability.provider.baseUrl,
            apiKey,
            authType: authType ?? 'bearer',
            signal: generationSignal,
          }, pendingMedia)
        }
        await runner.observeRemoteTerminal()
        runner.assertAuthority()
        terminalPlan = runner.resolveTerminal({
          status: 'completed',
          media: persistedMedia?.media ?? pendingMedia,
        })
      } catch (error) {
        terminalPlan = runner.resolveTerminal({
          status: 'failed',
          error: generationSignal.aborted
            ? '生成任务已停止'
            : error instanceof DurableMediaStorageError
              ? error.message
              : networkError(error, '模型服务', [apiKey]),
        })
      } finally {
        clearInterval(heartbeat)
        const confirmation = await runner.finalize(terminalPlan).catch(error => {
          log.error('generation', 'chat terminal confirmation failed', {
            generationId,
            name: error instanceof Error ? error.name : 'unknown',
          })
          return { confirmed: false as const }
        })
        if (persistedMedia && userId && conversationId) {
          const canonicalMedia = confirmation.confirmed && confirmation.status === 'completed'
            ? new Set(confirmation.media.map(item => `${item.type}:${item.url}`))
            : new Set<string>()
          const orphanReceipts = persistedMedia.receipts.filter((_, index) => {
            const media = persistedMedia!.media[index]
            return !canonicalMedia.has(`${media.type}:${media.url}`)
          })
          if (orphanReceipts.length) {
            await dependencies.cleanupMedia({ userId, conversationId, generationId }, orphanReceipts)
              .catch(error => log.error('generation', 'orphan chat media cleanup failed', {
                generationId,
                name: error instanceof Error ? error.name : 'unknown',
              }))
          }
        }
        if (confirmation.confirmed && confirmation.status === 'completed') {
          for (const media of confirmation.media) safeSend({ media })
        }
        const terminalEvent = terminalEventFromConfirmation(confirmation)
        if (terminalEvent) safeSend(terminalEvent)
        else safeSend({ error: '生成任务终态尚未确认，请重新载入会话' })

        if (!customEndpoint && userId && supabase) {
          try {
            await dependencies.addQuotaUsage(
              supabase,
              userId,
              totalTokensUsed,
              model,
              thinking,
              options.usingBalance,
            )
          } catch (error) {
            log.error('generation', 'quota accounting failed after terminal confirmation', {
              generationId,
              name: error instanceof Error ? error.name : 'unknown',
            })
          }
        }
        if (clientConnected && terminalEvent) {
          try { done(controller) } catch { clientConnected = false }
        } else if (clientConnected) {
          try { controller.close() } catch { clientConnected = false }
        }
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
