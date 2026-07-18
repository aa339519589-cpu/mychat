import type { SupabaseClient } from '@/lib/supabase/types'
import { hasScannedPdfAttachment, ocrScannedPdfs } from '@/lib/chat/attachments'
import { prepareChatHistory, RECENT_CONTEXT_MESSAGES } from '@/lib/chat/history'
import {
  latestBeijingDateFromMessages,
  prependDeepResearchInstruction,
  resolveReasoningEffort,
} from '@/lib/chat/request-context'
import { log } from '@/lib/logger'
import { runAgentLoop, type AgentLoopOpts, type ExecuteTool } from '@/lib/llm/agent-loop'
import { buildModelContext } from '@/lib/llm/context'
import type { ChatEvent } from '@/lib/llm/events'
import { ensureImageSummaries } from '@/lib/llm/image-context'
import { chatCompletionsUrl, injectAttachmentsOpenAI } from '@/lib/llm/openai'
import { buildSystem } from '@/lib/llm/system'
import { activeTools, execTool, toOpenAITools, type ToolContext } from '@/lib/tools'
import { isJobIdentifier } from '../contracts'
import { JobRuntimeError } from '../errors'
import { JobEventWriter } from '../event-writer'
import { executeFencedToolEffect } from '../tool-effects'
import type { JobExecutionContext, JobHandlerResult } from '../worker'
import type { LoadedChatJob } from './chat-input'
import { instantModelMessages } from './chat-instant'
import {
  CHAT_MEDIA_PERSISTENCE_DEFAULTS,
  type ChatMediaPersistenceDependencies,
  type DurableMediaPersistenceBatch,
  type GeneratedMedia,
} from './chat-media-persistence'
import { completeChatTextRun, rethrowChatTextFailure } from './chat-text-completion'
import {
  chatTokenAccounting,
  restoredHistoricalTokens,
  restoredTrajectory,
  trajectoryCheckpoint,
} from './chat-text-runtime'

const SAFETY_ROUNDS = 16
const MAX_OUTPUT_TOKENS = 40_000
const INSTANT_MAX_OUTPUT_TOKENS = 96
const REPLAY_SAFE_TOOLS = new Set(['web_search', 'fetch_url'])

type ActiveChatTools = ReturnType<typeof activeTools>

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

function createRuntime(context: JobExecutionContext): ChatTextRuntime {
  const writer = new JobEventWriter(context)
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

function chatTools(
  context: JobExecutionContext,
  input: LoadedChatJob,
  latestBeijingDate: string | null,
  instant: boolean,
): { tools: ActiveChatTools; toolContext: ToolContext } {
  const { selection, command } = input
  const projectId = input.context.project?.id ?? null
  return {
    tools: instant ? [] : activeTools({
      loggedIn: true,
      searchMode: command.searchMode,
      memoryEnabled: selection.customEndpoint ? false : input.context.memoryEnabled,
      projectId: selection.customEndpoint ? null : projectId,
    }),
    toolContext: {
      supabase: input.client,
      userId: input.userId,
      projectId,
      searchMode: command.searchMode,
      latestBeijingDate,
      signal: context.signal,
    },
  }
}

function chatSystem(input: LoadedChatJob, latestBeijingDate: string | null, historyContext: string): string {
  const { selection, command } = input
  const { memories, memoryEnabled, project } = input.context
  return buildSystem(
    !selection.customEndpoint && memoryEnabled && !project?.id ? memories : undefined,
    {
      searchMode: command.searchMode,
      latestBeijingDate,
      memoryEnabled: selection.customEndpoint ? false : memoryEnabled,
      project: selection.customEndpoint ? undefined : project,
      modelSource: selection.customEndpoint ? 'custom' : 'platform',
      tierLabel: selection.customEndpoint ? null : selection.platformTierLabel,
      modelId: selection.customEndpoint ? selection.model : null,
      endpointName: selection.customEndpoint ? selection.endpointDisplayName : null,
    },
  ) + historyContext
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

async function restoreChatTrajectory(
  context: JobExecutionContext,
  writer: JobEventWriter,
  modelMessages: AgentLoopOpts['messages'],
): Promise<number> {
  const baseLength = modelMessages.length
  if (context.job.checkpoint && !context.job.checkpoint.resumable) {
    throw new JobRuntimeError('JOB_RETRY_UNSAFE', 'Chat checkpoint is explicitly non-resumable', {
      class: 'internal',
      retryable: false,
    })
  }
  const restored = restoredTrajectory(context.job.checkpoint?.data)
  if (restored.length) {
    modelMessages.push(...restored)
    await writer.append('job.resumed', { checkpointMessages: restored.length })
  }
  return baseLength
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
  const instantMessages = instantModelMessages(input)
  const configuredTools = chatTools(context, input, latestBeijingDate, Boolean(instantMessages))
  if (instantMessages) {
    const baseLength = await restoreChatTrajectory(context, runtime.writer, instantMessages)
    return { ...configuredTools, modelMessages: instantMessages, baseLength, instant: true }
  }
  const history = await dependencies.prepareHistory({
    supabase: input.client as Parameters<typeof prepareChatHistory>[0]['supabase'],
    userId: input.userId,
    conversationId: input.conversationId,
    messages: input.context.messages,
    projectId: project?.id ?? null,
    tier: command.tier,
    historyRetrievalEnabled: command.historyRetrieval,
    customEndpoint: selection.customEndpoint,
    signal: context.signal,
  })
  const preparedMessages = await recentModelMessages(context, input, runtime, dependencies)
  const modelMessages: AgentLoopOpts['messages'] = [
    { role: 'system', content: chatSystem(input, latestBeijingDate, history.renderedContext) },
    ...buildModelContext(preparedMessages, selection.capability),
  ]
  if (command.deepResearch) prependDeepResearchInstruction(modelMessages)
  await appendAttachments(context, input, runtime, dependencies, modelMessages)
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
  const { selection, command } = input
  const isDeepTierProxy = selection.capability.provider.id === 'deep-tier'
  await dependencies.runAgentLoop({
    url: chatCompletionsUrl(selection.capability.provider.baseUrl),
    apiKey: selection.apiKey,
    model: selection.model,
    adapter: selection.capability.provider.adapter,
    thinking: prepared.instant ? false : selection.thinking,
    reasoningEffort: prepared.instant ? null : resolveReasoningEffort({
      isDeepTierProxy,
      deepResearch: command.deepResearch,
      modelId: selection.model,
    }),
    messages: prepared.modelMessages,
    tools: toOpenAITools(prepared.tools),
    emit: runtime.emit,
    executeTool: createToolExecutor(context, input, runtime, prepared, dependencies),
    maxRounds: prepared.instant ? 1 : SAFETY_ROUNDS,
    leakedRetry: !prepared.instant,
    autoContinue: prepared.instant ? undefined : { maxContinuations: 4 },
    onUsage: usageHandler(context, input, runtime),
    onCheckpoint: checkpointHandler(runtime, prepared.baseLength),
    turnOptions: {
      signal: context.signal,
      timeoutMs: prepared.instant ? 20_000 : 120_000,
      authType: selection.authType,
      logTiming: prepared.instant || isDeepTierProxy || process.env.DEBUG_LLM_TIMING === '1',
      maxOutputTokens: prepared.instant ? INSTANT_MAX_OUTPUT_TOKENS : MAX_OUTPUT_TOKENS,
      idempotencyNamespace: context.job.id,
    },
    onTurn: logTurn(context.job.id),
  })
}

export async function runChatTextJob(
  context: JobExecutionContext,
  input: LoadedChatJob,
  dependencyOverrides: Partial<ChatTextDependencies> = {},
): Promise<JobHandlerResult> {
  const dependencies: ChatTextDependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides }
  const runtime = createRuntime(context)
  try {
    context.assertAuthority()
    await runtime.writer.append('job.started', {
      type: context.job.type,
      attempt: context.job.attempt,
      model: input.selection.model,
    }, `${context.job.id}:started:${context.fence.leaseVersion}`)
    const prepared = await prepareChat(context, input, runtime, dependencies)
    await runPreparedChat(context, input, runtime, prepared, dependencies)
    return await completeChatTextRun(context, input, runtime, dependencies)
  } catch (error) {
    return rethrowChatTextFailure(error, context, input, runtime, dependencies)
  }
}
