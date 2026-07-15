import { createHmac } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '@/lib/supabase/admin'

const RPC_TIMEOUT_MS = 2_000
const LEASE_SECONDS = 45
const MAX_STREAM_SECONDS = 15 * 60

type RpcResponse = { data: unknown; error: unknown }
type Dependencies = {
  createAdminClient: () => SupabaseClient | null
  randomUUID: () => string
  rpcTimeoutMs: number
  addressHashKey: string | null
}

export type JobEventStreamLease = {
  id: string
  hardExpiresAt: string
  maxDurationMs: number
  renew: () => Promise<boolean>
  release: () => Promise<void>
}

export type JobEventStreamAdmission =
  | { acquired: true; lease: JobEventStreamLease }
  | { acquired: false; kind: 'capacity'; retryAfterSeconds: number }
  | { acquired: false; kind: 'unavailable'; retryAfterSeconds: number }

function record(value: unknown): Record<string, unknown> | null {
  const normalized = Array.isArray(value) ? value[0] : value
  return normalized !== null && typeof normalized === 'object' && !Array.isArray(normalized)
    ? normalized as Record<string, unknown>
    : null
}

async function rpc(
  client: SupabaseClient,
  name: string,
  args: Record<string, unknown>,
  timeoutMs: number,
): Promise<Record<string, unknown> | null> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    const response = await Promise.race([
      Promise.resolve(client.rpc(name, args) as unknown as PromiseLike<RpcResponse>),
      new Promise<null>(resolve => {
        timeout = setTimeout(() => resolve(null), timeoutMs)
      }),
    ])
    if (!response || response.error) return null
    return record(response.data)
  } catch {
    return null
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

export function streamAdmissionHashKey(
  environment: { NODE_ENV?: string; STREAM_ADMISSION_HASH_KEY?: string } = process.env,
): string | null {
  const dedicated = environment.STREAM_ADMISSION_HASH_KEY?.trim()
  if (dedicated) {
    return Buffer.byteLength(dedicated, 'utf8') >= 32 ? dedicated : null
  }
  return environment.NODE_ENV === 'development'
    ? 'mychat-development-stream-admission-key'
    : null
}

/** Store only a keyed, scoped digest; the short-lived lease table never receives a raw IP. */
export function jobEventStreamAddressHash(address: string, key: string): string {
  if (Buffer.byteLength(key, 'utf8') < 32) {
    throw new TypeError('Stream admission hash key is too short')
  }
  return createHmac('sha256', key).update(`mychat:job-stream:v1\0${address}`).digest('hex')
}

export async function acquireJobEventStreamLease(
  input: { principalId: string; jobId: string; address: string },
  dependencyOverrides: Partial<Dependencies> = {},
): Promise<JobEventStreamAdmission> {
  const dependencies: Dependencies = {
    createAdminClient,
    randomUUID: () => crypto.randomUUID(),
    rpcTimeoutMs: RPC_TIMEOUT_MS,
    addressHashKey: streamAdmissionHashKey(),
    ...dependencyOverrides,
  }
  const client = dependencies.createAdminClient()
  if (!client || !dependencies.addressHashKey) {
    return { acquired: false, kind: 'unavailable', retryAfterSeconds: 5 }
  }
  const id = dependencies.randomUUID()
  const result = await rpc(client, 'acquire_job_event_stream', {
    input_stream_id: id,
    input_principal_id: input.principalId,
    input_job_id: input.jobId,
    input_address_hash: jobEventStreamAddressHash(input.address, dependencies.addressHashKey),
    input_lease_seconds: LEASE_SECONDS,
    input_max_seconds: MAX_STREAM_SECONDS,
  }, dependencies.rpcTimeoutMs)
  if (!result) return { acquired: false, kind: 'unavailable', retryAfterSeconds: 5 }
  const retryAfter = Number.isSafeInteger(result.retryAfterSeconds)
    ? Math.max(1, Math.min(60, Number(result.retryAfterSeconds)))
    : 5
  if (result.acquired !== true) {
    return result.reason === 'capacity'
      ? { acquired: false, kind: 'capacity', retryAfterSeconds: retryAfter }
      : { acquired: false, kind: 'unavailable', retryAfterSeconds: retryAfter }
  }
  if (result.streamId !== id || typeof result.hardExpiresAt !== 'string'
    || !Number.isFinite(Date.parse(result.hardExpiresAt))) {
    return { acquired: false, kind: 'unavailable', retryAfterSeconds: 5 }
  }

  let released = false
  return {
    acquired: true,
    lease: {
      id,
      hardExpiresAt: result.hardExpiresAt,
      maxDurationMs: MAX_STREAM_SECONDS * 1_000,
      renew: async () => {
        if (released) return false
        const renewed = await rpc(client, 'renew_job_event_stream', {
          input_stream_id: id,
          input_lease_seconds: LEASE_SECONDS,
        }, dependencies.rpcTimeoutMs)
        return renewed?.renewed === true
      },
      release: async () => {
        if (released) return
        released = true
        await rpc(client, 'release_job_event_stream', {
          input_stream_id: id,
        }, dependencies.rpcTimeoutMs)
      },
    },
  }
}
