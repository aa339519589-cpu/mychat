import type { SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '@/lib/supabase/admin'
import { isIsoTimestamp, isJsonValue, type JsonObject } from './contracts'
import { JobRuntimeError } from './errors'
import {
  JOB_OUTBOX_TOPICS,
  type JobOutboxClaim,
  type JobOutboxMessage,
  type JobOutboxRepository,
  type JobOutboxTopic,
} from './outbox-contracts'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DEFAULT_RPC_TIMEOUT_MS = 8_000

type RpcResponse = { data: unknown; error: { code?: string } | null }
type RpcRequest = PromiseLike<RpcResponse> & {
  abortSignal?: (signal: AbortSignal) => PromiseLike<RpcResponse>
}

export type SupabaseOutboxDependencies = {
  createAdminClient: () => SupabaseClient | null
  rpcTimeoutMs: number
}

function objectOf(value: unknown): Record<string, unknown> | null {
  const normalized = Array.isArray(value) ? value[0] : value
  return normalized !== null && typeof normalized === 'object' && !Array.isArray(normalized)
    ? normalized as Record<string, unknown>
    : null
}

function parsePayload(value: unknown): JsonObject | null {
  return isJsonValue(value) && value !== null && !Array.isArray(value) && typeof value === 'object'
    ? value
    : null
}

function parseMessage(value: unknown): JobOutboxMessage | null {
  const row = objectOf(value)
  if (!row || !UUID_PATTERN.test(String(row.id)) || !UUID_PATTERN.test(String(row.jobId))
    || !UUID_PATTERN.test(String(row.principalId))
    || !JOB_OUTBOX_TOPICS.includes(row.topic as JobOutboxTopic)
    || !Number.isSafeInteger(row.attempt) || Number(row.attempt) < 1
    || !Number.isSafeInteger(row.maxAttempts) || Number(row.maxAttempts) < 1
    || Number(row.maxAttempts) > 100 || Number(row.attempt) > Number(row.maxAttempts)
    || !Number.isSafeInteger(row.lockVersion) || Number(row.lockVersion) < 1
    || !isIsoTimestamp(row.lockExpiresAt) || !isIsoTimestamp(row.createdAt)) return null
  const payload = parsePayload(row.payload)
  if (!payload) return null
  return {
    id: String(row.id),
    jobId: String(row.jobId),
    principalId: String(row.principalId),
    topic: row.topic as JobOutboxTopic,
    payload,
    attempt: Number(row.attempt),
    maxAttempts: Number(row.maxAttempts),
    lockVersion: Number(row.lockVersion),
    lockExpiresAt: row.lockExpiresAt,
    createdAt: row.createdAt,
  }
}

function rejected(operation: string, reason: unknown): never {
  throw new JobRuntimeError('JOB_LEASE_STALE', 'Outbox delivery lock was rejected', {
    details: { operation, reason: typeof reason === 'string' ? reason : 'unknown' },
  })
}

export class SupabaseJobOutboxRepository implements JobOutboxRepository {
  private readonly dependencies: SupabaseOutboxDependencies

  constructor(dependencies: Partial<SupabaseOutboxDependencies> = {}) {
    this.dependencies = {
      createAdminClient,
      rpcTimeoutMs: DEFAULT_RPC_TIMEOUT_MS,
      ...dependencies,
    }
  }

  private client(): SupabaseClient {
    const client = this.dependencies.createAdminClient()
    if (!client) throw new JobRuntimeError(
      'JOB_DEPENDENCY_UNAVAILABLE',
      'Outbox repository is unavailable',
    )
    return client
  }

  private async rpc(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const controller = new AbortController()
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      const raw = this.client().rpc(name, args) as unknown as RpcRequest
      const operation = typeof raw.abortSignal === 'function' ? raw.abortSignal(controller.signal) : raw
      const response = await Promise.race([
        Promise.resolve(operation),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            controller.abort()
            reject(new JobRuntimeError('JOB_TIMEOUT', 'Outbox repository operation timed out'))
          }, this.dependencies.rpcTimeoutMs)
        }),
      ])
      if (response.error) throw new JobRuntimeError(
        'JOB_DEPENDENCY_UNAVAILABLE',
        'Outbox repository operation failed',
        { details: { operation: name, databaseCode: response.error.code ?? 'unknown' } },
      )
      const result = objectOf(response.data)
      if (!result) throw new JobRuntimeError(
        'JOB_DEPENDENCY_UNAVAILABLE',
        'Outbox repository returned malformed data',
        { details: { operation: name } },
      )
      return result
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  }

  async claim(input: {
    workerId: string
    topics: readonly JobOutboxTopic[]
    lockSeconds: number
  }): Promise<JobOutboxClaim> {
    const result = await this.rpc('claim_job_outbox', {
      input_worker_id: input.workerId,
      input_topics: [...input.topics],
      input_lock_seconds: input.lockSeconds,
    })
    if (result.acquired !== true) return { acquired: false, message: null }
    const message = parseMessage(result.message)
    if (!message) throw new JobRuntimeError(
      'JOB_DEPENDENCY_UNAVAILABLE',
      'Outbox claim returned a malformed message',
    )
    return { acquired: true, message }
  }

  async renew(input: {
    outboxId: string
    workerId: string
    lockVersion: number
    lockSeconds: number
  }): Promise<void> {
    const result = await this.rpc('renew_job_outbox', {
      input_outbox_id: input.outboxId,
      input_worker_id: input.workerId,
      input_lock_version: input.lockVersion,
      input_lock_seconds: input.lockSeconds,
    })
    if (result.renewed !== true) rejected('renew', result.reason)
  }

  async publish(input: { outboxId: string; workerId: string; lockVersion: number }): Promise<void> {
    const result = await this.complete(input, true, null, 30)
    if (result.completed !== true) rejected('publish', result.reason)
  }

  async fail(input: {
    outboxId: string
    workerId: string
    lockVersion: number
    errorCode: string
    retrySeconds: number
  }): Promise<void> {
    const result = await this.complete(input, false, input.errorCode, input.retrySeconds)
    if (result.completed !== true) rejected('fail', result.reason)
  }

  private complete(
    input: { outboxId: string; workerId: string; lockVersion: number },
    succeeded: boolean,
    error: string | null,
    retrySeconds: number,
  ): Promise<Record<string, unknown>> {
    return this.rpc('complete_job_outbox', {
      input_outbox_id: input.outboxId,
      input_worker_id: input.workerId,
      input_lock_version: input.lockVersion,
      input_succeeded: succeeded,
      input_error: error,
      input_retry_seconds: retrySeconds,
    })
  }

  async cleanupAssets(input: { message: JobOutboxMessage; workerId: string }): Promise<number> {
    const prepared = await this.rpc('prepare_job_asset_cleanup', {
      input_outbox_id: input.message.id,
      input_worker_id: input.workerId,
      input_lock_version: input.message.lockVersion,
    })
    if (prepared.prepared !== true) rejected('prepare_asset_cleanup', prepared.reason)
    if (prepared.bucket !== 'generated-media' || !Array.isArray(prepared.objectKeys)
      || prepared.objectKeys.length > 256
      || prepared.objectKeys.some(key => typeof key !== 'string' || key.length < 1
        || key.length > 1024 || key.includes('..') || !key.startsWith(`${input.message.principalId}/`)
        || !key.includes(`/${input.message.jobId}/`))) {
      throw new JobRuntimeError('JOB_DEPENDENCY_UNAVAILABLE', 'Asset cleanup plan is malformed')
    }
    const objectKeys = [...new Set(prepared.objectKeys as string[])]
    if (objectKeys.length > 0) {
      const { error } = await this.client().storage.from('generated-media').remove(objectKeys)
      if (error) throw new JobRuntimeError(
        'JOB_DEPENDENCY_UNAVAILABLE',
        'Generated media cleanup failed',
        { details: { storageCode: error.name || 'unknown' } },
      )
    }
    const finished = await this.rpc('finish_job_asset_cleanup', {
      input_outbox_id: input.message.id,
      input_worker_id: input.workerId,
      input_lock_version: input.message.lockVersion,
      input_object_keys: objectKeys,
    })
    if (finished.finished !== true) rejected('finish_asset_cleanup', finished.reason)
    return objectKeys.length
  }
}
