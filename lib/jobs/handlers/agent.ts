import { codeContinuationPrompt, codeTurnContentPolicy } from '@/lib/agent/continuation'
import { saveAgentRunState } from '@/lib/agent/run-state'
import { finalCodeTaskStatus } from '@/lib/code-agent/runtime'
import { buildCodeSystem } from '@/lib/code-agent/system-prompt'
import { runAgentLoop, type AgentLoopOpts } from '@/lib/llm/agent-loop'
import { chatCompletionsUrl, toOpenAI } from '@/lib/llm/openai'
import { weightedTokenUsage } from '@/lib/quota'
import { log } from '@/lib/logger'
import type { ModelMessage } from '@/lib/llm/types'
import type { JobExecutionContext, JobHandler, JobHandlerResult } from '../worker'
import type { JobAccounting } from '../repository'
import { JobRuntimeError } from '../errors'
import { JobEventWriter, jsonResult } from '../event-writer'
import { BILLING_PRICE_VERSION, platformModelCostMicros } from '../pricing'
import { loadAgentJob, type LoadedAgentJob } from './agent-input'
import { createAgentRuntime } from './agent-runtime'
import {
  restoredHistoricalTokens,
  restoredTrajectory,
  trajectoryCheckpoint,
} from './chat-text-runtime'

export function agentTokenAccounting(
  input: Pick<Awaited<ReturnType<typeof loadAgentJob>>, 'model' | 'thinking' | 'usingBalance'>,
  jobId: string,
  attemptTokens: number,
): JobAccounting[] {
  if (attemptTokens <= 0) return []
  const weightedTokens = weightedTokenUsage(attemptTokens, input.model, input.thinking)
  return [{
    idempotencyKey: `${jobId}:model-usage`,
    reason: 'agent_model_usage',
    direction: 'debit',
    weightedTokens,
    rawTokens: attemptTokens,
    model: input.model,
    provider: 'deepseek',
    costMicros: platformModelCostMicros(weightedTokens),
    metadata: { usingBalance: input.usingBalance, priceVersion: BILLING_PRICE_VERSION },
  }]
}

type AgentRuntime = ReturnType<typeof createAgentRuntime>

type PreparedAgentRun = {
  messages: ModelMessage[]
  baseLength: number
  historicalTokens: number
}

type AgentRunTracking = {
  attemptTokens: number
  totalTokens: number
  checkpointRound: number
}

export type AgentTaskDependencies = {
  createRuntime: typeof createAgentRuntime
  runLoop: typeof runAgentLoop
  saveRunState: typeof saveAgentRunState
  apiKey: () => string | undefined
}

const DEFAULT_DEPENDENCIES: AgentTaskDependencies = {
  createRuntime: createAgentRuntime,
  runLoop: runAgentLoop,
  saveRunState: saveAgentRunState,
  apiKey: () => process.env.DEEPSEEK_API_KEY,
}

function prepareAgentRun(
  context: JobExecutionContext,
  input: LoadedAgentJob,
  canExecute: boolean,
): PreparedAgentRun {
  const system = buildCodeSystem(input.repo, input.login, input.memories, input.workspaceReady, canExecute)
  const messages: ModelMessage[] = [{ role: 'system', content: system }, ...toOpenAI(input.messages)]
  const baseLength = messages.length
  if (context.job.checkpoint && !context.job.checkpoint.resumable) {
    throw new JobRuntimeError('JOB_RETRY_UNSAFE', 'Agent checkpoint is explicitly non-resumable', {
      class: 'internal', retryable: false,
    })
  }
  const restored = restoredTrajectory(context.job.checkpoint?.data)
  if (restored.length) messages.push(...restored)
  return { messages, baseLength, historicalTokens: restoredHistoricalTokens(context.job) }
}

function createAgentLoopCallbacks(input: {
  context: JobExecutionContext
  job: LoadedAgentJob
  writer: JobEventWriter
  prepared: PreparedAgentRun
  saveRunState: typeof saveAgentRunState
}): Pick<AgentLoopOpts, 'onUsage' | 'onTurn' | 'onCheckpoint'> & { tracking: AgentRunTracking } {
  const { context, job, writer, prepared, saveRunState } = input
  const tracking: AgentRunTracking = {
    attemptTokens: 0,
    totalTokens: prepared.historicalTokens,
    checkpointRound: 0,
  }
  return {
    tracking,
    onUsage: async total => {
      tracking.attemptTokens = total
      tracking.totalTokens = prepared.historicalTokens + total
      for (const entry of agentTokenAccounting(job, context.job.id, total)) {
        context.reportAccounting(entry)
      }
      await context.flushAccounting()
    },
    onTurn: ({ phase, round, turn }) => log.info('jobs', 'Agent model turn', {
      jobId: context.job.id, phase, round: round ?? null,
      finishReason: turn.finishReason, tools: turn.toolCalls.map(call => call.name),
    }),
    onCheckpoint: async latestMessages => {
      tracking.checkpointRound++
      const checkpoint = trajectoryCheckpoint(
        latestMessages, prepared.baseLength, tracking.checkpointRound,
      )
      await writer.checkpoint({
        phase: 'agent.model_round',
        data: checkpoint.data,
        resumable: checkpoint.resumable,
        extraProgress: { totalTokens: tracking.totalTokens },
      })
      await saveRunState(job.client, job.userId, job.taskId, {
        resumeMessages: latestMessages.slice(prepared.baseLength),
      })
    },
  }
}

function agentLoopOptions(input: {
  context: JobExecutionContext
  job: LoadedAgentJob
  runtime: AgentRuntime
  prepared: PreparedAgentRun
  apiKey: string
  callbacks: Pick<AgentLoopOpts, 'onUsage' | 'onTurn' | 'onCheckpoint'>
}): AgentLoopOpts {
  const { context, job, runtime, prepared, apiKey, callbacks } = input
  return {
    url: chatCompletionsUrl('https://api.deepseek.com'),
    apiKey,
    model: job.model,
    adapter: 'deepseek-openai',
    thinking: job.thinking,
    messages: prepared.messages,
    tools: runtime.tools,
    emit: runtime.events.emit,
    executeTool: runtime.executeTool,
    maxRounds: 80,
    leakedRetry: true,
    autoContinue: { maxContinuations: 6 },
    idleContinuation: {
      maxContinuations: 20,
      prompt: () => codeContinuationPrompt(runtime.progress.snapshot(job.workspaceReady)),
    },
    ...callbacks,
    turnOptions: {
      deferTextUntilTurnEnd: true,
      contentPolicy: codeTurnContentPolicy,
      signal: context.signal,
      timeoutMs: 120_000,
      maxOutputTokens: 40_000,
      idempotencyNamespace: context.job.id,
    },
  }
}

async function completeAgentRun(input: {
  context: JobExecutionContext
  job: LoadedAgentJob
  runtime: AgentRuntime
  writer: JobEventWriter
  attemptTokens: number
}): Promise<JobHandlerResult> {
  const { context, job, runtime, writer, attemptTokens } = input
  const content = writer.text()
  const state = runtime.progress.snapshot(job.workspaceReady)
  const taskStatus = finalCodeTaskStatus(false, state)
  if (taskStatus === 'running') {
    throw new JobRuntimeError('JOB_INTERNAL', 'Agent stopped before a durable completion point')
  }
  await runtime.recorder.artifact('summary', {
    title: 'Code Agent 回复', content,
    meta: { responseId: job.responseId, sessionId: job.sessionId, ...state },
  })
  return {
    status: 'completed',
    result: jsonResult({
      schemaVersion: 1,
      taskId: job.taskId,
      sessionId: job.sessionId,
      responseId: job.responseId,
      content,
      taskStatus,
      progress: state,
    }),
    ledgerEntries: agentTokenAccounting(job, context.job.id, attemptTokens),
  }
}

function rethrowAgentError(error: unknown, signal: AbortSignal): never {
  if (error instanceof JobRuntimeError) throw error
  if (signal.aborted) throw signal.reason
  throw new JobRuntimeError('JOB_DEPENDENCY_UNAVAILABLE', 'Agent execution dependency failed', {
    class: 'provider', cause: error,
  })
}

export async function runAgentTaskJob(
  context: JobExecutionContext,
  input: LoadedAgentJob,
  overrides: Partial<AgentTaskDependencies> = {},
): Promise<JobHandlerResult> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides }
  const writer = new JobEventWriter(context)
  const runtime = dependencies.createRuntime(context, input, writer)
  await runtime.recorder.setTaskStatus('running')
  const prepared = prepareAgentRun(context, input, runtime.canExecute)
  const callbacks = createAgentLoopCallbacks({
    context, job: input, writer, prepared, saveRunState: dependencies.saveRunState,
  })
  try {
    const apiKey = dependencies.apiKey()?.trim()
    if (!apiKey) throw new JobRuntimeError(
      'JOB_DEPENDENCY_UNAVAILABLE', 'DeepSeek provider is not configured',
      { class: 'policy', retryable: false },
    )
    await writer.append('job.started', { taskId: input.taskId, model: input.model },
      `${context.job.id}:started:${context.fence.leaseVersion}`)
    await dependencies.runLoop(agentLoopOptions({
      context, job: input, runtime, prepared, apiKey, callbacks,
    }))
    runtime.events.flushLeadText()
    await writer.drain()
    return await completeAgentRun({
      context, job: input, runtime, writer, attemptTokens: callbacks.tracking.attemptTokens,
    })
  } catch (error) {
    rethrowAgentError(error, context.signal)
  }
}

export const handleAgentTask: JobHandler = async context => (
  runAgentTaskJob(context, await loadAgentJob(context))
)
