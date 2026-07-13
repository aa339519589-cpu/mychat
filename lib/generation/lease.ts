import type { SupabaseClient } from '@supabase/supabase-js'
import { log } from '@/lib/logger'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  isTerminalGenerationStatus,
  normalizeGenerationMedia,
  type GenerationDatabaseRow,
  type GenerationLeaseClaimReason,
  type GenerationLeaseClaimResult,
  type GenerationLeaseMutationResult,
  type GenerationStatus,
} from './types'

const DEFAULT_LEASE_SECONDS = 45
const DEFAULT_RPC_TIMEOUT_MS = 8_000

export type GenerationCoordinationDependencies = {
  createAdminClient: () => SupabaseClient | null
}

const DEFAULT_COORDINATION_DEPENDENCIES: GenerationCoordinationDependencies = {
  createAdminClient,
}

type RpcObject = Record<string, unknown>

function rpcObject(data: unknown): RpcObject | null {
  const value = Array.isArray(data) ? data[0] : data
  return value && typeof value === 'object' ? value as RpcObject : null
}

function statusOf(value: unknown): GenerationStatus | null {
  if (value === 'queued' || value === 'running' || isTerminalGenerationStatus(value)) return value
  return null
}

function claimReasonOf(value: unknown): GenerationLeaseClaimReason {
  if (value === 'terminal' || value === 'stale' || value === 'assistant_conflict'
    || value === 'conversation_active'
    || value === 'identity_mismatch' || value === 'invalid_parent'
    || value === 'not_found') return value
  return 'active'
}

function rpcErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

async function withRpcTimeout<T>(
  operation: PromiseLike<T>,
  timeoutMs = DEFAULT_RPC_TIMEOUT_MS,
  onTimeout?: () => void,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.resolve(operation),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => {
            onTimeout?.()
            reject(new DOMException('Generation coordination RPC timed out', 'TimeoutError'))
          },
          timeoutMs,
        )
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

function rpcWithTimeout(
  supabase: SupabaseClient,
  rpcName: string,
  args: Record<string, unknown>,
  timeoutMs = DEFAULT_RPC_TIMEOUT_MS,
) {
  const controller = new AbortController()
  const request = supabase.rpc(rpcName, args)
  const abortable = request as typeof request & {
    abortSignal?: (signal: AbortSignal) => PromiseLike<Awaited<typeof request>>
  }
  const operation = typeof abortable.abortSignal === 'function'
    ? abortable.abortSignal(controller.signal)
    : request
  return withRpcTimeout(operation, timeoutMs, () => controller.abort())
}

function coordinationClient(
  dependencyOverrides: Partial<GenerationCoordinationDependencies>,
): SupabaseClient | null {
  try {
    return {
      ...DEFAULT_COORDINATION_DEPENDENCIES,
      ...dependencyOverrides,
    }.createAdminClient()
  } catch (error) {
    log.error('generation', 'Generation coordination client is unavailable', {
      name: error instanceof Error ? error.name : 'unknown',
    })
    return null
  }
}

export async function claimGenerationLease(
  input: {
    userId: string
    generationId: string
    conversationId: string
    assistantMessageId: string
    runnerId: string
    leaseSeconds?: number
  },
  dependencyOverrides: Partial<GenerationCoordinationDependencies> = {},
): Promise<GenerationLeaseClaimResult> {
  const supabase = coordinationClient(dependencyOverrides)
  if (!supabase) return { ok: false, errorCode: 'admin_not_configured' }
  try {
    const { data, error } = await rpcWithTimeout(supabase, 'claim_chat_generation', {
      input_generation_id: input.generationId,
      input_user_id: input.userId,
      input_conversation_id: input.conversationId,
      input_assistant_message_id: input.assistantMessageId,
      input_runner_id: input.runnerId,
      lease_seconds: input.leaseSeconds ?? DEFAULT_LEASE_SECONDS,
    })
    if (error) {
      log.error('generation', 'lease claim failed', {
        generationId: input.generationId,
        code: error.code,
      })
      return { ok: false, errorCode: error.code }
    }
    const result = rpcObject(data)
    const media = normalizeGenerationMedia(result?.media)
    if (!media) return { ok: false, errorCode: 'invalid_media_response' }
    if (!result || result.acquired !== true) {
      return {
        ok: true,
        acquired: false,
        status: statusOf(result?.status),
        reason: claimReasonOf(result?.reason),
        media,
      }
    }
    const version = Number(result.leaseVersion)
    const expiresAt = result.leaseExpiresAt
    if (!Number.isSafeInteger(version) || version < 1 || typeof expiresAt !== 'string'
      || !Number.isFinite(Date.parse(expiresAt))) {
      log.error('generation', 'lease claim returned malformed fencing token', {
        generationId: input.generationId,
      })
      return { ok: false }
    }
    return {
      ok: true,
      acquired: true,
      status: 'running',
      lease: { runnerId: input.runnerId, version, expiresAt },
      media,
    }
  } catch (error) {
    log.error('generation', 'lease claim exception', {
      generationId: input.generationId,
      name: error instanceof Error ? error.name : 'unknown',
    })
    return { ok: false, errorCode: rpcErrorCode(error) }
  }
}

export async function renewGenerationLease(
  input: {
    userId: string
    generationId: string
    runnerId: string
    leaseVersion: number
    leaseSeconds?: number
    timeoutMs?: number
  },
  dependencyOverrides: Partial<GenerationCoordinationDependencies> = {},
): Promise<'renewed' | 'lost' | 'unavailable'> {
  const supabase = coordinationClient(dependencyOverrides)
  if (!supabase) return 'unavailable'
  try {
    const { data, error } = await rpcWithTimeout(supabase, 'renew_chat_generation_lease', {
      input_generation_id: input.generationId,
      input_user_id: input.userId,
      input_runner_id: input.runnerId,
      input_lease_version: input.leaseVersion,
      lease_seconds: input.leaseSeconds ?? DEFAULT_LEASE_SECONDS,
    }, input.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS)
    if (error) {
      log.error('generation', 'lease renewal failed', {
        generationId: input.generationId,
        code: error.code,
      })
      return 'unavailable'
    }
    return data === true ? 'renewed' : 'lost'
  } catch (error) {
    log.error('generation', 'lease renewal exception', {
      generationId: input.generationId,
      name: error instanceof Error ? error.name : 'unknown',
    })
    return 'unavailable'
  }
}

export async function persistGenerationProgress(
  input: {
    userId: string
    generationId: string
    runnerId: string
    leaseVersion: number
    content: string
    thinking: string
    sequence: number
  },
  dependencyOverrides: Partial<GenerationCoordinationDependencies> = {},
): Promise<GenerationLeaseMutationResult> {
  return mutateGeneration('write_chat_generation_progress', {
    input_generation_id: input.generationId,
    input_user_id: input.userId,
    input_runner_id: input.runnerId,
    input_lease_version: input.leaseVersion,
    input_content: input.content,
    input_thinking: input.thinking,
    input_sequence: input.sequence,
  }, input.generationId, dependencyOverrides)
}

export async function finalizeGenerationLease(
  input: {
    userId: string
    generationId: string
    runnerId: string
    leaseVersion: number
    status: 'completed' | 'failed' | 'cancelled'
    content: string
    thinking: string
    sequence: number
    error?: string
    media?: import('@/lib/generated-media').GeneratedMedia[]
  },
  dependencyOverrides: Partial<GenerationCoordinationDependencies> = {},
): Promise<GenerationLeaseMutationResult> {
  return mutateGeneration('finalize_chat_generation', {
    input_generation_id: input.generationId,
    input_user_id: input.userId,
    input_runner_id: input.runnerId,
    input_lease_version: input.leaseVersion,
    input_status: input.status,
    input_content: input.content,
    input_thinking: input.thinking,
    input_sequence: input.sequence,
    input_error: input.error ?? null,
    input_media: input.media ?? [],
  }, input.generationId, dependencyOverrides)
}

export async function requestGenerationCancellation(
  input: { userId: string; generationId: string },
  dependencyOverrides: Partial<GenerationCoordinationDependencies> = {},
): Promise<GenerationLeaseMutationResult> {
  return mutateGeneration('cancel_chat_generation', {
    input_generation_id: input.generationId,
    input_user_id: input.userId,
  }, input.generationId, dependencyOverrides)
}

export function isGenerationLeaseExpired(
  row: Pick<GenerationDatabaseRow, 'status' | 'lease_expires_at'>,
  now = Date.now(),
): boolean {
  if (row.status !== 'queued' && row.status !== 'running') return false
  if (!row.lease_expires_at) return true
  const expiresAt = Date.parse(row.lease_expires_at)
  return !Number.isFinite(expiresAt) || expiresAt <= now
}

export async function failStaleGeneration(
  input: { userId: string; generationId: string },
  dependencyOverrides: Partial<GenerationCoordinationDependencies> = {},
): Promise<GenerationLeaseMutationResult> {
  return mutateGeneration('fail_stale_chat_generation', {
    input_generation_id: input.generationId,
    input_user_id: input.userId,
  }, input.generationId, dependencyOverrides)
}

async function mutateGeneration(
  rpcName: string,
  args: Record<string, unknown>,
  generationId: string,
  dependencyOverrides: Partial<GenerationCoordinationDependencies>,
): Promise<GenerationLeaseMutationResult> {
  const supabase = coordinationClient(dependencyOverrides)
  if (!supabase) return { ok: false, errorCode: 'admin_not_configured' }
  try {
    const { data, error } = await rpcWithTimeout(supabase, rpcName, args)
    if (error) {
      log.error('generation', `${rpcName} failed`, { generationId, code: error.code })
      return { ok: false, errorCode: error.code }
    }
    const result = rpcObject(data)
    if (!result || typeof result.accepted !== 'boolean') return { ok: false }
    const media = normalizeGenerationMedia(result.media)
    if (!media) return { ok: false, errorCode: 'invalid_media_response' }
    return {
      ok: true,
      accepted: result.accepted,
      status: statusOf(result.status),
      ...(typeof result.error === 'string' ? { error: result.error } : {}),
      ...(typeof result.content === 'string' ? { content: result.content } : {}),
      ...(typeof result.thinking === 'string' ? { thinking: result.thinking } : {}),
      ...(Number.isSafeInteger(Number(result.sequence))
        ? { sequence: Number(result.sequence) }
        : {}),
      media,
    }
  } catch (error) {
    log.error('generation', `${rpcName} exception`, {
      generationId,
      name: error instanceof Error ? error.name : 'unknown',
    })
    return { ok: false, errorCode: rpcErrorCode(error) }
  }
}
