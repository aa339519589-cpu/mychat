import { codeContinuationPrompt, codeTurnContentPolicy } from '@/lib/agent/continuation'
import { saveAgentRunState } from '@/lib/agent/run-state'
import { finalCodeTaskStatus } from '@/lib/code-agent/runtime'
import { buildCodeSystem } from '@/lib/code-agent/system-prompt'
import { runAgentLoop } from '@/lib/llm/agent-loop'
import { chatCompletionsUrl, toOpenAI } from '@/lib/llm/openai'
import { weightedTokenUsage } from '@/lib/quota'
import { log } from '@/lib/logger'
import type { ModelMessage } from '@/lib/llm/types'
import type { JobHandler } from '../worker'
import { JobRuntimeError } from '../errors'
import { JobEventWriter, jsonResult } from '../event-writer'
import { loadAgentJob } from './agent-input'
import { createAgentRuntime } from './agent-runtime'
import { restoredTrajectory, trajectoryCheckpoint } from './chat-text-runtime'

export const handleAgentTask: JobHandler = async context => {
  const input = await loadAgentJob(context)
  const writer = new JobEventWriter(context)
  const { recorder, canExecute, tools, events, progress, executeTool } = createAgentRuntime(context, input, writer)
  await recorder.setTaskStatus('running')
  const system = buildCodeSystem(input.repo, input.login, input.memories, true, canExecute)
  const messages: ModelMessage[] = [{ role: 'system', content: system }, ...toOpenAI(input.messages)]
  const baseLength = messages.length
  const restored = restoredTrajectory(context.job.checkpoint)
  if (restored.length) messages.push(...restored)
  let totalTokens = 0
  let checkpointRound = 0
  try {
    if (!process.env.DEEPSEEK_API_KEY?.trim()) {
      throw new JobRuntimeError('JOB_DEPENDENCY_UNAVAILABLE', 'DeepSeek provider is not configured', {
        class: 'policy', retryable: false,
      })
    }
    await writer.append('job.started', { taskId: input.taskId, model: input.model }, `${context.job.id}:started:${context.fence.leaseVersion}`)
    await runAgentLoop({
      url: chatCompletionsUrl('https://api.deepseek.com'),
      apiKey: process.env.DEEPSEEK_API_KEY,
      model: input.model,
      adapter: 'deepseek-openai',
      thinking: input.thinking,
      messages,
      tools,
      emit: events.emit,
      executeTool,
      maxRounds: 80,
      leakedRetry: true,
      autoContinue: { maxContinuations: 6 },
      idleContinuation: {
        maxContinuations: 20,
        prompt: () => codeContinuationPrompt(progress.snapshot(true)),
      },
      onUsage: total => { totalTokens = total },
      onTurn: ({ phase, round, turn }) => log.info('jobs', 'Agent model turn', {
        jobId: context.job.id, phase, round: round ?? null,
        finishReason: turn.finishReason, tools: turn.toolCalls.map(call => call.name),
      }),
      onCheckpoint: async latestMessages => {
        checkpointRound++
        const checkpoint = trajectoryCheckpoint(latestMessages, baseLength, checkpointRound)
        await writer.checkpoint({
          phase: 'agent.model_round', data: checkpoint.data,
          resumable: checkpoint.resumable, extraProgress: { totalTokens },
        })
        await saveAgentRunState(input.client, input.userId, input.taskId, {
          resumeMessages: latestMessages.slice(baseLength),
        })
      },
      turnOptions: {
        deferTextUntilTurnEnd: true,
        contentPolicy: codeTurnContentPolicy,
        signal: context.signal,
        timeoutMs: 120_000,
        maxOutputTokens: 40_000,
        idempotencyNamespace: context.job.id,
      },
    })
    const content = events.flushLeadText()
    await writer.drain()
    const state = progress.snapshot(true)
    const taskStatus = finalCodeTaskStatus(false, state)
    if (taskStatus === 'running') throw new JobRuntimeError('JOB_INTERNAL', 'Agent stopped before a durable completion point')
    await recorder.artifact('summary', {
      title: 'Code Agent 回复', content,
      meta: { responseId: input.responseId, sessionId: input.sessionId, ...state },
    })
    return {
      status: 'completed',
      result: jsonResult({
        schemaVersion: 1,
        taskId: input.taskId,
        sessionId: input.sessionId,
        responseId: input.responseId,
        content,
        taskStatus,
        progress: state,
      }),
      ledgerEntries: totalTokens > 0 ? [{
        idempotencyKey: `${context.job.id}:model-usage`, reason: 'agent_model_usage', direction: 'debit',
        weightedTokens: weightedTokenUsage(totalTokens, input.model, input.thinking),
        rawTokens: totalTokens, model: input.model, provider: 'deepseek',
        metadata: { usingBalance: input.usingBalance },
      }] : [],
    }
  } catch (error) {
    if (error instanceof JobRuntimeError) throw error
    if (context.signal.aborted) throw context.signal.reason
    throw new JobRuntimeError('JOB_DEPENDENCY_UNAVAILABLE', 'Agent execution dependency failed', {
      class: 'provider', cause: error,
    })
  }
}
