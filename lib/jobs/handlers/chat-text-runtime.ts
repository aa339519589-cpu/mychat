import { log } from '@/lib/logger'
import type { AgentLoopOpts } from '@/lib/llm/agent-loop'
import { JobRuntimeError } from '../errors'
import type { JobEventWriter } from '../event-writer'
import type { JobExecutionContext, JobHandlerResult } from '../worker'
import { createHash } from 'node:crypto'
import type { ModelMessage } from '@/lib/llm/types'
import { weightedTokenUsage } from '@/lib/quota'
import type { JobAccounting } from '../repository'
import type { JobRecord, JsonObject } from '../contracts'
import { jsonResult } from '../event-writer'
import type { LoadedChatJob } from './chat-input'
import { BILLING_PRICE_VERSION, platformModelCostMicros } from '../pricing'

const MAX_CHECKPOINT_BYTES = 850_000

export function nativeHealthContextMetadata(value: string | undefined): JsonObject {
  return value ? { nativeHealthContextChars: value.length,
    nativeHealthContextSha256: createHash('sha256').update(value).digest('hex') } : {}
}

export function trajectoryCheckpoint(messages: ModelMessage[], baseLength: number, round: number): {
  data: JsonObject
  resumable: boolean
} {
  const trajectory = messages.slice(baseLength)
  const serialized = JSON.stringify(trajectory)
  const digest = createHash('sha256').update(serialized).digest('hex')
  if (Buffer.byteLength(serialized) > MAX_CHECKPOINT_BYTES) {
    return { data: { schemaVersion: 1, round, trajectorySha256: digest, oversized: true }, resumable: false }
  }
  return {
    data: jsonResult({ schemaVersion: 1, round, trajectorySha256: digest, trajectory }) as JsonObject,
    resumable: true,
  }
}

export function restoredTrajectory(value: unknown): ModelMessage[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  const source = value as Record<string, unknown>
  if (source.schemaVersion !== 1 || !Array.isArray(source.trajectory)) return []
  const serialized = JSON.stringify(source.trajectory)
  if (Buffer.byteLength(serialized) > MAX_CHECKPOINT_BYTES) return []
  const digest = createHash('sha256').update(serialized).digest('hex')
  if (source.trajectorySha256 !== digest) return []
  return source.trajectory as ModelMessage[]
}

export function restoredCheckpointTokens(value: unknown): number {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 0
  const totalTokens = (value as Record<string, unknown>).totalTokens
  return Number.isSafeInteger(totalTokens) && Number(totalTokens) >= 0
    ? Number(totalTokens)
    : 0
}

/**
 * A recovered checkpoint is presentation state, while durable ledger usage is
 * the billing authority. Use the larger historical value for cumulative
 * progress, but never feed it back into the current attempt's ledger entry.
 */
export function restoredHistoricalTokens(
  job: Pick<JobRecord, 'checkpoint' | 'usage'>,
): number {
  return Math.max(
    restoredCheckpointTokens(job.checkpoint?.progress),
    job.usage.rawTokens,
  )
}

export function chatTokenAccounting(
  input: LoadedChatJob,
  jobId: string,
  attemptTokens: number,
): JobAccounting[] {
  const selection = input.selection
  const weighted = selection.customEndpoint
    ? 0
    : weightedTokenUsage(attemptTokens, selection.model, selection.thinking)
  if (attemptTokens <= 0 && weighted <= 0) return []
  return [{
    idempotencyKey: `${jobId}:model-usage`,
    reason: selection.customEndpoint ? 'custom_model_usage' : 'platform_model_usage',
    direction: 'debit',
    weightedTokens: weighted,
    rawTokens: Math.max(0, Math.round(attemptTokens)),
    model: selection.model,
    provider: selection.capability.provider.id,
    costMicros: platformModelCostMicros(weighted, selection.customEndpoint),
    currency: 'USD',
    metadata: {
      thinking: selection.thinking,
      usingBalance: input.command.usingBalance,
      customEndpoint: selection.customEndpoint,
      priceVersion: BILLING_PRICE_VERSION,
    },
  }]
}

export async function restoreChatTrajectory(
  context: JobExecutionContext, writer: JobEventWriter, modelMessages: AgentLoopOpts['messages'],
): Promise<number> {
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
  return baseLength
}

export async function timedChatPreparation<T>(jobId: string, stage: string, operation: () => Promise<T>): Promise<T> {
  const startedAt = Date.now()
  try { return await operation() } finally {
    log.info('jobs', 'Chat preparation stage timing', { jobId, stage, elapsedMs: Date.now() - startedAt })
  }
}

export function withHistoryIndexOutbox(result: JobHandlerResult, input: {
  jobId: string; conversationId: string; enabled: boolean
}): JobHandlerResult {
  // Finalization commits this item atomically with the completed reply. The
  // outbox owns durable retries, so embeddings never delay chat terminal.
  if (result.status !== 'completed' || !input.enabled) return result
  return { ...result, outbox: [...(result.outbox ?? []), {
    kind: 'history.index', dedupeKey: `${input.jobId}:history-index`,
    payload: { conversationId: input.conversationId },
  }] }
}
