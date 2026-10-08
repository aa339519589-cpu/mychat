import type { SupabaseClient } from '@/lib/supabase/types'
import { hasScannedPdfAttachment, ocrScannedPdfs } from '@/lib/chat/attachments'
import { prepareChatHistory, RECENT_CONTEXT_MESSAGES } from '@/lib/chat/history'
import {
  latestBeijingDateFromMessages,
} from '@/lib/chat/request-context'
import { log } from '@/lib/logger'
import { runAgentLoop, type AgentLoopOpts, type ExecuteTool } from '@/lib/llm/agent-loop'
import { buildModelContext, appendNativeHealthContext } from '@/lib/llm/context'
import type { ChatEvent } from '@/lib/llm/events'
import { ensureImageSummaries } from '@/lib/llm/image-context'
import { chatCompletionsUrl, injectAttachmentsOpenAI } from '@/lib/llm/openai'
import type { ReasoningEffort } from '@/lib/llm/provider-adapters'
import type { TokenUsage } from '@/lib/token-usage'
import { execTool, toOpenAITools, type ToolContext } from '@/lib/tools'
import { isJobIdentifier } from '../contracts'
import { JobRuntimeError } from '../errors'
import { JobEventWriter } from '../event-writer'
import { executeFencedToolEffect } from '../tool-effects'
import type { JobExecutionContext, JobHandlerResult } from '../worker'
import type { LoadedChatJob } from './chat-input'
import {
  CHAT_MEDIA_PERSISTENCE_DEFAULTS,
  type ChatMediaPersistenceDependencies,
  type DurableMediaPersistenceBatch,
  type GeneratedMedia,
} from './chat-media-persistence'
import { completeChatTextRun, rethrowChatTextFailure } from './chat-text-completion'
import { buildChatSystem, buildChatTools, type ActiveChatTools } from './chat-text-context'
import {
  chatTokenAccounting,
  nativeHealthContextMetadata,
  restoreChatTrajectory,
  timedChatPreparation,
  withHistoryIndexOutbox,
  restoredHistoricalTokens,
  trajectoryCheckpoint,
} from './chat-text-runtime'

const SAFETY_ROUNDS = 16
const MAX_OUTPUT_TOKENS = 40_000
const TRIAL_MAX_OUTPUT_TOKENS = 10_000
const REPLAY_SAFE_TOOLS = new Set(['web_search', 'fetch_url', 'search_connector_tools'])

export type ChatTextDependencies = ChatMediaPersistenceDependencies & {
  runAgentLoop: typeof runAgentLoop
  prepareHistory: typeof prepareChatHistory
  ensureImageSummaries: typeof ensureImageSummaries
  ocrAttachments: typeof ocrScannedPdfs
  injectAttachments: typeof injectAttachmentsOpenAI
  executeToolEffect: typeof executeFencedToolEffect
  executeTool: typeof execTool
}

export type ChatTextRuntime = {
  writer: JobEventWriter
  emit: (event: ChatEvent) => void
  pendingMedia: GeneratedMedia[]
  historicalTokens: number
  attemptTokens: number
  totalTokens: number
  tokenUsage?: TokenUsage
  persistedMedia: DurableMediaPersistenceBatch | null
}

type PreparedChat = {
  modelMessages: AgentLoopOpts['messages']
  tools: ActiveChatTools
  toolContext: ToolContext
  baseLength: number
  instant: boolean
}

const DEFAULT_DEPENDENCIES: ChatTextDependencies = {
  runAgentLoop,
  prepareHistory: prepareChatHistory,
  ensureImageSummaries,
  ocrAttachments: ocrScannedPdfs,
  injectAttachments: injectAttachmentsOpenAI,
  executeToolEffect: executeFencedToolEffect,
  executeTool: execTool,
  ...CHAT_MEDIA_PERSISTENCE_DEFAULTS,
}

function safeToolCallId(value: string | undefined): string {
  if (!isJobIdentifier(value) || value.length > 200) {
    throw new JobRuntimeError('JOB_INVALID_INPUT', 'Provider tool call id is invalid')
  }
  return value
}

function createRuntime(context: JobExecutionContext, writer = new JobEventWriter(context)): ChatTextRuntime {
  const pendingMedia: GeneratedMedia[] = []
  const historicalTokens = restoredHistoricalTokens(context.job)
  return {
    writer,
    pendingMedia,
    historicalTokens,
    attemptTokens: 0,
    totalTokens: historicalTokens,
    persistedMedia: null,
    emit: event => {
      if ('media' in event) pendingMedia.push(event.media)
      else writer.emit(event)
    },
  }
}

async function recentModelMessages(
  context: JobExecutionContext,
  input: LoadedChatJob,
  runtime: ChatTextRuntime,
  dependencies: ChatTextDependencies,
) {
  const recent = input.context.messages.slice(-RECENT_CONTEXT_MESSAGES)
  if (input.selection.customEndpoint || input.selection.capability.supportsImageInput) return recent
  return dependencies.ensureImageSummaries(recent, {
    supabase: input.client,
    userId: input.userId,
    emit: runtime.emit,
    signal: context.signal,
  })
}

async function appendAttachments(
  context: JobExecutionContext,
  input: LoadedChatJob,
  runtime: ChatTextRuntime,
  dependencies: ChatTextDependencies,
  modelMessages: AgentLoopOpts['messages'],
): Promise<void> {
  if (!input.selection.customEndpoint && hasScannedPdfAttachment(input.command.attachments)) {
    runtime.emit({ thinking: '正在识别扫描件内容，请稍候……' })
  }
  const attachments = await dependencies.ocrAttachments(input.command.attachments, context.signal)
  await dependencies.injectAttachments(modelMessages, attachments)
}

async function prepareChat(
  context: JobExecutionContext,
  input: LoadedChatJob,
  runtime: ChatTextRuntime,
  dependencies: ChatTextDependencies,
): Promise<PreparedChat> {
  const { selection, command } = input
  const project = input.context.project
  const latestBeijingDate = latestBeijingDateFromMessages(input.context.messages)
  // Connector discovery, cross-conversation retrieval and image context are
  // independent reads. Do not put all three round trips before the first model
  // request in series; still await every required input before calling it.
  const [configuredTools, history, preparedMessages] = await Promise.all([
    timedChatPreparation(context.job.id, 'tools', () => buildChatTools(context, input, latestBeijingDate, false)),
    timedChatPreparation(context.job.id, 'history', () => dependencies.prepareHistory({
      supabase: input.client as Parameters<typeof prepareChatHistory>[0]['supabase'],
      userId: input.userId,
      conversationId: input.conversationId,
      messages: input.context.messages,
      projectId: project?.id ?? null,
      tier: command.tier,
      historyRetrievalEnabled: command.historyRetrieval,
      customEndpoint: selection.customEndpoint,
      signal: context.signal,
      deferIndexing: true,
    })),
    timedChatPreparation(context.job.id, 'images', () => recentModelMessages(context, input, runtime, dependencies)),
  ])
  if (history.sources?.length) {
    runtime.emit({
      search: {
        kind: 'history',
        query: history.query ?? '',
        results: history.sources.map(source => ({
          title: source.conversationTitle?.trim() || '未命名聊天',
          url: `mychat://conversation/${encodeURIComponent(source.conversationId)}`,
          snippet: source.snippet,
          conversation_id: source.conversationId,
          message_start_id: source.messageStartId ?? undefined,
        })),
      },
    })
  }
  const modelMessages: AgentLoopOpts['messages'] = [
    { role: 'system', content: buildChatSystem(input, latestBeijingDate, history.renderedContext) },
    ...buildModelContext(history.degraded ? input.context.messages : preparedMessages, selection.capability),
  ]
  if (history.degraded) runtime.emit({ error: '其他历史检索暂时不可用，已保留当前对话与已读记忆。' })
  await timedChatPreparation(context.job.id, 'attachments', () => appendAttachments(context, input, runtime, dependencies, modelMessages))
  appendNativeHealthContext(modelMessages, command.healthContext)
  const baseLength = await restoreChatTrajectory(context, runtime.writer, modelMessages)
  return { ...configuredTools, modelMessages, baseLength, instant: false }
}

function createToolExecutor(
  context: JobExecutionContext,
  input: LoadedChatJob,
  runtime: ChatTextRuntime,
  prepared: PreparedChat,
  dependencies: ChatTextDependencies,
): ExecuteTool {
  return async (name, args, execution) => {
    context.budget.consumeToolCall()
    const toolCallId = safeToolCallId(execution?.toolCallId)
    await runtime.writer.append(
      'tool.requested',
      { toolCallId, toolName: name },
      `${toolCallId}:requested`,
    )
    let outcomeEvent: object | undefined
    const effect = await dependencies.executeToolEffect({
      client: input.client as SupabaseClient,
      fence: context.fence,
      toolCallId,
      toolName: name,
      args,
      replaySafe: REPLAY_SAFE_TOOLS.has(name),
      execute: async () => {
        const outcome = await dependencies.executeTool(prepared.tools, name, args, prepared.toolContext)
        outcomeEvent = outcome.event
        return outcome.result
      },
    })
    if (outcomeEvent) runtime.emit(outcomeEvent as ChatEvent)
    await runtime.writer.append('tool.completed', {
      toolCallId,
      toolName: name,
      replayed: effect.replayed,
    }, `${toolCallId}:completed`)
    return effect.result
  }
}

function usageHandler(
  context: JobExecutionContext,
  input: LoadedChatJob,
  runtime: ChatTextRuntime,
): (value: number) => Promise<void> {
  return async value => {
    runtime.attemptTokens = value
    runtime.totalTokens = runtime.historicalTokens + value
    for (const entry of chatTokenAccounting(input, context.job.id, value)) {
      context.reportAccounting(entry)
    }
    await context.flushAccounting()
  }
}

function checkpointHandler(
  runtime: ChatTextRuntime,
  baseLength: number,
): AgentLoopOpts['onCheckpoint'] {
  let round = 0
  return async trajectory => {
    round++
    const checkpoint = trajectoryCheckpoint(trajectory, baseLength, round)
    await runtime.writer.checkpoint({
      phase: 'chat.model_round',
      data: checkpoint.data,
      resumable: checkpoint.resumable,
      extraProgress: { totalTokens: runtime.totalTokens },
    })
  }
}

function logTurn(jobId: string): NonNullable<AgentLoopOpts['onTurn']> {
  return ({ phase, round, turn }) => log.info('jobs', 'Chat worker model turn', {
    jobId,
    phase,
    round: round ?? null,
    finishReason: turn.finishReason,
    failed: turn.failed,
    providerStatus: turn.errorStatus ?? null,
    toolCalls: turn.toolCalls.length,
    contentLength: turn.content.length,
  })
}

async function runPreparedChat(
  context: JobExecutionContext,
  input: LoadedChatJob,
  runtime: ChatTextRuntime,
  prepared: PreparedChat,
  dependencies: ChatTextDependencies,
): Promise<void> {
  const { selection } = input
  const isDeepTierProxy = selection.capability.provider.id === 'deep-tier'
  const trial = selection.accessClass === 'trial'
  const providerStartedAt = Date.now()
  let firstTextLogged = false
  let outputCompletionPersistence: Promise<void> | null = null
  const reportOutputCompleted = () => {
    if (outputCompletionPersistence) return
    // The model has stopped producing output. Publish that fact before usage
    // durability; this is not a completed job or an accounting acknowledgement.
    outputCompletionPersistence = runtime.writer.append(
      'model.output_completed',
      {
        phase: 'provider_complete',
        contentLength: runtime.writer.text().length,
        thinkingLength: runtime.writer.thinking().length,
      },
      `${context.job.id}:model-output-completed:${context.fence.leaseVersion}`,
    )
  }
  const result = await dependencies.runAgentLoop({
    url: chatCompletionsUrl(selection.capability.provider.baseUrl),
    apiKey: selection.apiKey,
    model: selection.model,
    adapter: selection.capability.provider.adapter,
    thinking: selection.thinking,
    reasoningEffort: selection.reasoningEffort as ReasoningEffort | null,
    messages: prepared.modelMessages,
    tools: toOpenAITools(prepared.tools),
    emit: event => {
      if ('text' in event && event.text && !firstTextLogged) {
        firstTextLogged = true
        log.info('jobs', 'Chat first model text timing', {
          jobId: context.job.id, model: selection.model,
          providerToFirstTextMs: Date.now() - providerStartedAt,
        })
      }
      runtime.emit(event)
    },
    executeTool: createToolExecutor(context, input, runtime, prepared, dependencies),
    maxRounds: SAFETY_ROUNDS,
    leakedRetry: true,
    autoContinue: trial ? undefined : { maxContinuations: 4 },
    onUsage: usageHandler(context, input, runtime),
    onCheckpoint: checkpointHandler(runtime, prepared.baseLength),
    turnOptions: {
      signal: context.signal,
      timeoutMs: 120_000,
      authType: selection.authType,
      logTiming: isDeepTierProxy || process.env.DEBUG_LLM_TIMING === '1',
      maxOutputTokens: trial ? TRIAL_MAX_OUTPUT_TOKENS : MAX_OUTPUT_TOKENS,
      idempotencyNamespace: context.job.id,
    },
    onTurn: logTurn(context.job.id),
    onOutputCompleted: reportOutputCompleted,
  })
  runtime.tokenUsage = result.tokenUsage
  // This is the semantic end of model output. Durable accounting, media
  // persistence, and job finalization continue afterwards, but the composer
  // must stop presenting an active "stop generation" control immediately.
  reportOutputCompleted()
  await outputCompletionPersistence
}

export async function runChatTextJob(
  context: JobExecutionContext,
  input: LoadedChatJob,
  dependencyOverrides: Partial<ChatTextDependencies> = {},
  writer?: JobEventWriter,
): Promise<JobHandlerResult> {
  const dependencies: ChatTextDependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides }
  const runtime = createRuntime(context, writer)
  try {
    context.assertAuthority()
    await runtime.writer.append('job.started', {
      type: context.job.type,
      attempt: context.job.attempt,
      model: input.selection.model,
    }, `${context.job.id}:started:${context.fence.leaseVersion}`)
    const preparedStartedAt = Date.now()
    const prepared = await prepareChat(context, input, runtime, dependencies)
    log.info('jobs', 'Chat model input preparation timing', {
      jobId: context.job.id, preparationMs: Date.now() - preparedStartedAt,
      instant: prepared.instant, tools: prepared.tools.length,
      ...nativeHealthContextMetadata(input.command.healthContext),
    })
    await runPreparedChat(context, input, runtime, prepared, dependencies)
    const result = await completeChatTextRun(context, input, runtime, dependencies)
    return withHistoryIndexOutbox(result, {
      jobId: context.job.id, conversationId: input.conversationId,
      enabled: input.command.historyRetrieval,
    })
  } catch (error) {
    return rethrowChatTextFailure(error, context, input, runtime, dependencies)
  }
}
