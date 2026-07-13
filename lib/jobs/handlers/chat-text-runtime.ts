import { createHash } from 'node:crypto'
import type { ModelMessage } from '@/lib/llm/types'
import { weightedTokenUsage } from '@/lib/quota'
import type { JobAccounting } from '../repository'
import type { JsonObject } from '../contracts'
import { jsonResult } from '../event-writer'
import type { LoadedChatJob } from './chat-input'

const MAX_CHECKPOINT_BYTES = 850_000

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

export function chatTokenAccounting(
  input: LoadedChatJob,
  jobId: string,
  totalTokens: number,
): JobAccounting[] {
  const selection = input.selection
  const weighted = selection.customEndpoint
    ? 0
    : weightedTokenUsage(totalTokens, selection.model, selection.thinking)
  if (totalTokens <= 0 && weighted <= 0) return []
  return [{
    idempotencyKey: `${jobId}:model-usage`,
    reason: selection.customEndpoint ? 'custom_model_usage' : 'platform_model_usage',
    direction: 'debit',
    weightedTokens: weighted,
    rawTokens: Math.max(0, Math.round(totalTokens)),
    model: selection.model,
    provider: selection.capability.provider.id,
    costEstimate: 0,
    currency: 'USD',
    metadata: {
      thinking: selection.thinking,
      usingBalance: input.command.usingBalance,
      customEndpoint: selection.customEndpoint,
    },
  }]
}
