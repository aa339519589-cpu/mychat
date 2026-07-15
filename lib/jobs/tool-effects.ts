import type { SupabaseClient } from '@supabase/supabase-js'
import { sha256JobBytes } from './canonical'
import type { JobFence, JsonObject } from './contracts'
import { JobRuntimeError } from './errors'

type ToolEffectStatus = 'reserved' | 'running' | 'succeeded' | 'failed' | 'compensated' | 'unknown'

type ToolEffectResult = {
  recorded: boolean
  replayed: boolean
  reason: string | null
  effectId: string | null
  status: ToolEffectStatus | null
  resultRef: JsonObject | null
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function parseResult(value: unknown): ToolEffectResult {
  const source = object(Array.isArray(value) ? value[0] : value)
  const statuses = new Set<ToolEffectStatus>([
    'reserved', 'running', 'succeeded', 'failed', 'compensated', 'unknown',
  ])
  if (!source || typeof source.recorded !== 'boolean' || typeof source.replayed !== 'boolean') {
    throw new JobRuntimeError('JOB_DEPENDENCY_UNAVAILABLE', 'Tool effect store returned malformed data')
  }
  const status = typeof source.status === 'string' && statuses.has(source.status as ToolEffectStatus)
    ? source.status as ToolEffectStatus
    : null
  const resultRef = object(source.resultRef) as JsonObject | null
  return {
    recorded: source.recorded,
    replayed: source.replayed,
    reason: typeof source.reason === 'string' ? source.reason : null,
    effectId: typeof source.effectId === 'string' ? source.effectId : null,
    status,
    resultRef,
  }
}

async function recordEffect(input: {
  client: SupabaseClient
  fence: JobFence
  toolCallId: string
  toolName: string
  argsHash: string
  effectKey: string
  status: ToolEffectStatus
  resultRef?: JsonObject
  replaySafe: boolean
  metadata?: JsonObject
}): Promise<ToolEffectResult> {
  const { data, error } = await input.client.rpc('record_job_tool_effect', {
    input_job_id: input.fence.jobId,
    input_worker_id: input.fence.workerId,
    input_lease_version: input.fence.leaseVersion,
    input_tool_call_id: input.toolCallId,
    input_tool_name: input.toolName,
    input_args_hash: input.argsHash,
    input_effect_key: input.effectKey,
    input_status: input.status,
    input_result_ref: input.resultRef ?? null,
    input_replay_safe: input.replaySafe,
    input_metadata: input.metadata ?? {},
  })
  if (error) throw new JobRuntimeError(
    'JOB_DEPENDENCY_UNAVAILABLE',
    'Tool effect store is unavailable',
    { details: { databaseCode: error.code ?? 'unknown' } },
  )
  const result = parseResult(data)
  if (!result.recorded && !result.replayed) {
    throw new JobRuntimeError(
      result.reason === 'cancel_requested' ? 'JOB_CANCEL_REQUESTED' : 'JOB_LEASE_STALE',
      result.reason === 'cancel_requested' ? 'Job cancellation was requested' : 'Tool effect fence was rejected',
    )
  }
  return result
}

function storedResult(result: string): { reference: JsonObject; replaySafe: boolean } {
  const bytes = new TextEncoder().encode(result)
  if (bytes.byteLength <= 200_000) {
    return { reference: { result, sha256: sha256JobBytes(bytes) }, replaySafe: true }
  }
  return {
    reference: { sha256: sha256JobBytes(bytes), bytes: bytes.byteLength, truncated: true },
    replaySafe: false,
  }
}

function replayedSucceededResult(effect: ToolEffectResult): string {
  const result = effect.resultRef?.result
  if (typeof result !== 'string') {
    throw new JobRuntimeError(
      'JOB_RETRY_UNSAFE',
      'A completed tool effect has no replayable result; refusing to execute it again',
      { class: 'internal', retryable: false },
    )
  }
  const bytes = new TextEncoder().encode(result)
  if (effect.resultRef?.sha256 !== sha256JobBytes(bytes)) {
    throw new JobRuntimeError(
      'JOB_RETRY_UNSAFE',
      'A completed tool effect result failed its integrity check',
      { class: 'internal', retryable: false },
    )
  }
  return result
}

export async function executeFencedToolEffect(input: {
  client: SupabaseClient
  fence: JobFence
  toolCallId: string
  toolName: string
  args: unknown
  replaySafe: boolean
  execute: () => Promise<string>
}): Promise<{ result: string; replayed: boolean }> {
  const serializedArgs = JSON.stringify(input.args) ?? 'null'
  const argsHash = sha256JobBytes(serializedArgs)
  const common = {
    client: input.client,
    fence: input.fence,
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    argsHash,
    effectKey: `${input.fence.jobId}:${input.toolCallId}`,
  }
  const reserved = await recordEffect({
    ...common,
    status: 'reserved',
    replaySafe: input.replaySafe,
    metadata: { argsHash },
  })
  if (reserved.replayed && reserved.status === 'succeeded') {
    return { result: replayedSucceededResult(reserved), replayed: true }
  }
  if (reserved.replayed && reserved.status && reserved.status !== 'reserved') {
    throw new JobRuntimeError(
      'JOB_RETRY_UNSAFE',
      `Tool effect is already ${reserved.status}; refusing an ambiguous replay`,
      { class: 'internal', retryable: false },
    )
  }
  await recordEffect({ ...common, status: 'running', replaySafe: input.replaySafe })
  try {
    const result = await input.execute()
    const stored = storedResult(result)
    await recordEffect({
      ...common,
      status: 'succeeded',
      replaySafe: input.replaySafe && stored.replaySafe,
      resultRef: stored.reference,
    })
    return { result, replayed: false }
  } catch (error) {
    await recordEffect({
      ...common,
      status: 'failed',
      replaySafe: input.replaySafe,
      resultRef: { error: error instanceof Error ? error.name : 'unknown' },
    }).catch(() => undefined)
    throw error
  }
}
