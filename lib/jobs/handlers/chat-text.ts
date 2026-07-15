import type { SupabaseClient } from '@supabase/supabase-js'
import { ocrScannedPdfs, hasScannedPdfAttachment } from '@/lib/chat/attachments'
import { prepareChatHistory, RECENT_CONTEXT_MESSAGES } from '@/lib/chat/history'
import type { LoadedChatJob } from '@/lib/jobs/handlers/chat-input'
import { runAgentLoop, type AgentLoopOpts, type ExecuteTool } from '@/lib/llm/agent-loop'
import { buildModelContext } from '@/lib/llm/context'
import type { ChatEvent } from '@/lib/llm/events'
import { ensureImageSummaries } from '@/lib/llm/image-context'
import { chatCompletionsUrl, injectAttachmentsOpenAI } from '@/lib/llm/openai'
import { buildSystem } from '@/lib/llm/system'
import { activeTools, execTool, toOpenAITools, type ToolContext } from '@/lib/tools'
import {
  latestBeijingDateFromMessages,
  prependDeepResearchInstruction,
  resolveReasoningEffort,
} from '@/lib/chat/request-context'
import { log } from '@/lib/logger'
import type { JobExecutionContext, JobHandlerResult } from '../worker'
import { JobEventWriter, jsonResult } from '../event-writer'
import { executeFencedToolEffect } from '../tool-effects'
import { JobRuntimeError } from '../errors'
import {
  chatTokenAccounting,
  restoredHistoricalTokens,
  restoredTrajectory,
  trajectoryCheckpoint,
} from './chat-text-runtime'
import {
  CHAT_MEDIA_PERSISTENCE_DEFAULTS,
  cleanupChatInlineMedia,
  persistChatInlineMedia,
  type ChatMediaPersistenceDependencies,
  type DurableMediaPersistenceBatch,
  type GeneratedMedia,
} from './chat-media-persistence'

const SAFETY_ROUNDS = 16
const MAX_OUTPUT_TOKENS = 40_000
const REPLAY_SAFE_TOOLS = new Set(['web_search', 'fetch_url'])

type ChatTextDependencies = ChatMediaPersistenceDependencies & {
  runAgentLoop: typeof runAgentLoop
}

const DEFAULT_DEPENDENCIES: ChatTextDependencies = {
  runAgentLoop,
  ...CHAT_MEDIA_PERSISTENCE_DEFAULTS,
}

function safeToolCallId(value: string | undefined): string {
  if (!value || value.length > 200) throw new JobRuntimeError('JOB_INVALID_INPUT', 'Provider tool call id is invalid')
  return value
}

export async function runChatTextJob(
  context: JobExecutionContext,
  input: LoadedChatJob,
  dependencyOverrides: Partial<ChatTextDependencies> = {},
): Promise<JobHandlerResult> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides }
  const writer = new JobEventWriter(context)
  const { selection, command } = input
  const { messages, memories, memoryEnabled, project } = input.context
  const latestBeijingDate = latestBeijingDateFromMessages(messages)
  const tools = activeTools({
    loggedIn: true,
    searchMode: command.searchMode,
    memoryEnabled: selection.customEndpoint ? false : memoryEnabled,
    projectId: selection.customEndpoint ? null : (project?.id ?? null),
  })
  const toolContext: ToolContext = {
    supabase: input.client,
    userId: input.userId,
    projectId: project?.id ?? null,
    searchMode: command.searchMode,
    latestBeijingDate,
    signal: context.signal,
  }
  const recentMessages = messages.slice(-RECENT_CONTEXT_MESSAGES)
  const pendingMedia: GeneratedMedia[] = []
  const emit = (event: ChatEvent) => {
    if ('media' in event) pendingMedia.push(event.media)
    else writer.emit(event)
  }
  const historicalTokens = restoredHistoricalTokens(context.job)
  let attemptTokens = 0
  let totalTokens = historicalTokens
  let persistedMedia: DurableMediaPersistenceBatch | null = null

  try {
    context.assertAuthority()
    await writer.append('job.started', {
      type: context.job.type,
      attempt: context.job.attempt,
      model: selection.model,
    }, `${context.job.id}:started:${context.fence.leaseVersion}`)
    const history = await prepareChatHistory({
      supabase: input.client as Parameters<typeof prepareChatHistory>[0]['supabase'],
      userId: input.userId,
      conversationId: input.conversationId,
      messages,
      projectId: project?.id ?? null,
      tier: command.tier,
      historyRetrievalEnabled: command.historyRetrieval,
      customEndpoint: selection.customEndpoint,
      signal: context.signal,
    })
    const system = buildSystem(
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
    ) + history.renderedContext
    const preparedMessages = selection.customEndpoint || selection.capability.supportsImageInput
      ? recentMessages
      : await ensureImageSummaries(recentMessages, {
        supabase: input.client,
        userId: input.userId,
        emit,
        signal: context.signal,
      })
    const modelMessages: AgentLoopOpts['messages'] = [
      { role: 'system', content: system },
      ...buildModelContext(preparedMessages, selection.capability),
    ]
    if (command.deepResearch) prependDeepResearchInstruction(modelMessages)
    if (!selection.customEndpoint && hasScannedPdfAttachment(command.attachments)) {
      emit({ thinking: '正在识别扫描件内容，请稍候……' })
    }
    const processedAttachments = await ocrScannedPdfs(command.attachments, context.signal)
    await injectAttachmentsOpenAI(modelMessages, processedAttachments)
    const baseLength = modelMessages.length
    if (context.job.checkpoint && !context.job.checkpoint.resumable) {
      throw new JobRuntimeError('JOB_RETRY_UNSAFE', 'Chat checkpoint is explicitly non-resumable', {
        class: 'internal', retryable: false,
      })
    }
    const restored = restoredTrajectory(context.job.checkpoint?.data)
    if (restored.length) {
      modelMessages.push(...restored)
      await writer.append('job.resumed', { checkpointMessages: restored.length })
    }
    let checkpointRound = 0
    const executeTool: ExecuteTool = async (name, args, execution) => {
      context.budget.consumeToolCall()
      const toolCallId = safeToolCallId(execution?.toolCallId)
      await writer.append('tool.requested', { toolCallId, toolName: name }, `${toolCallId}:requested`)
      let outcomeEvent: object | undefined
      const effect = await executeFencedToolEffect({
        client: input.client as SupabaseClient,
        fence: context.fence,
        toolCallId,
        toolName: name,
        args,
        replaySafe: REPLAY_SAFE_TOOLS.has(name),
        execute: async () => {
          const outcome = await execTool(tools, name, args, toolContext)
          outcomeEvent = outcome.event
          return outcome.result
        },
      })
      if (outcomeEvent) emit(outcomeEvent as ChatEvent)
      await writer.append('tool.completed', {
        toolCallId,
        toolName: name,
        replayed: effect.replayed,
      }, `${toolCallId}:completed`)
      return effect.result
    }
    const isDeepTierProxy = selection.capability.provider.id === 'deep-tier'
    await dependencies.runAgentLoop({
      url: chatCompletionsUrl(selection.capability.provider.baseUrl),
      apiKey: selection.apiKey,
      model: selection.model,
      adapter: selection.capability.provider.adapter,
      thinking: selection.thinking,
      reasoningEffort: resolveReasoningEffort({
        isDeepTierProxy,
        deepResearch: command.deepResearch,
        modelId: selection.model,
      }),
      messages: modelMessages,
      tools: toOpenAITools(tools),
      emit,
      executeTool,
      maxRounds: SAFETY_ROUNDS,
      leakedRetry: true,
      autoContinue: { maxContinuations: 4 },
      onUsage: async value => {
        attemptTokens = value
        totalTokens = historicalTokens + attemptTokens
        for (const entry of chatTokenAccounting(input, context.job.id, attemptTokens)) {
          context.reportAccounting(entry)
        }
        await context.flushAccounting()
      },
      onCheckpoint: async trajectory => {
        checkpointRound++
        const checkpoint = trajectoryCheckpoint(trajectory, baseLength, checkpointRound)
        await writer.checkpoint({
          phase: 'chat.model_round',
          data: checkpoint.data,
          resumable: checkpoint.resumable,
          extraProgress: { totalTokens },
        })
      },
      turnOptions: {
        signal: context.signal,
        timeoutMs: 120_000,
        authType: selection.authType,
        logTiming: isDeepTierProxy || process.env.DEBUG_LLM_TIMING === '1',
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        idempotencyNamespace: context.job.id,
      },
      onTurn: ({ phase, round, turn }) => log.info('jobs', 'Chat worker model turn', {
        jobId: context.job.id,
        phase,
        round: round ?? null,
        finishReason: turn.finishReason,
        toolCalls: turn.toolCalls.length,
        contentLength: turn.content.length,
      }),
    })
    await writer.drain()
    context.assertAuthority()
    if (pendingMedia.length) {
      persistedMedia = await persistChatInlineMedia(context, input, pendingMedia, dependencies)
    }
    context.assertAuthority()
    return {
      status: 'completed',
      result: jsonResult({
        schemaVersion: 1,
        content: writer.text(),
        thinking: writer.thinking(),
        media: persistedMedia?.media ?? [],
        mediaRefs: persistedMedia?.media ?? [],
        assetObjectKeys: persistedMedia?.receipts.map(receipt => receipt.objectKey) ?? [],
        irreversibleCommitted: Boolean(persistedMedia?.media.length),
        model: selection.model,
        totalTokens,
      }),
      ledgerEntries: chatTokenAccounting(input, context.job.id, attemptTokens),
    }
  } catch (error) {
    if (persistedMedia) {
      await cleanupChatInlineMedia(context, input, persistedMedia, dependencies).catch(() => undefined)
    }
    if (error instanceof JobRuntimeError) throw error
    if (context.signal.aborted) throw context.signal.reason
    throw new JobRuntimeError('JOB_DEPENDENCY_UNAVAILABLE', 'Chat generation dependency failed', {
      class: 'provider',
      cause: error,
    })
  }
}
