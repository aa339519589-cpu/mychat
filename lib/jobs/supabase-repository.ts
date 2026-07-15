import type { SupabaseClient } from '@supabase/supabase-js'
import { log } from '@/lib/logger'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  JOB_EVENT_SCHEMA_VERSION,
  JOB_LIMITS,
  assertEnqueueJobInput,
  assertJobEvents,
  assertJobFence,
  isIsoTimestamp,
  isJobIdentifier,
  isJobName,
  isJsonValue,
  isTerminalJobStatus,
  type JobAuthClass,
  type JobBudget,
  type JobCheckpoint,
  type JobRecord,
  type JobUsage,
  type JsonObject,
} from './contracts'
import { JobRuntimeError } from './errors'
import type { JobRepository } from './repository'
import type {
  JobClaimResult,
  JobEventsMutationResult,
  JobFinalizeResult,
  JobRenewResult,
} from './repository-types'
import { retrySupabaseJob } from './supabase-retry'
import { resumeSupabaseJob } from './supabase-resume'
import { recordSupabaseJobAccounting } from './supabase-accounting'
import { checkpointSupabaseJobWithAccounting } from './supabase-checkpoint'
import {
  failureOf, integerOf, jsonObjectOf, jsonOf, malformed,
  nullableInteger, objectOf, statusOf,
} from './supabase-parsing'

const DEFAULT_RPC_TIMEOUT_MS = 8_000

export type SupabaseJobRepositoryDependencies = {
  createAdminClient: () => SupabaseClient | null
  rpcTimeoutMs: number
}

const DEFAULT_DEPENDENCIES: SupabaseJobRepositoryDependencies = {
  createAdminClient,
  rpcTimeoutMs: DEFAULT_RPC_TIMEOUT_MS,
}

type RpcError = { code?: string }
type RpcResponse = { data: unknown; error: RpcError | null }
type RpcRequest = PromiseLike<RpcResponse> & {
  abortSignal?: (signal: AbortSignal) => PromiseLike<RpcResponse>
}

function rpcObject(value: unknown): Record<string, unknown> | null {
  return objectOf(Array.isArray(value) ? value[0] : value)
}

function checkpointOf(value: unknown, rpcName: string): JobCheckpoint | null {
  if (value == null) return null
  const source = objectOf(value)
  const version = integerOf(source?.version)
  const leaseVersion = integerOf(source?.leaseVersion)
  const data = source ? objectOf(source.data) : null
  const progress = source ? objectOf(source.progress) : null
  if (!source || version === null || version < 1 || leaseVersion === null || leaseVersion < 1
    || !isJobName(source.phase, 128) || !data || !progress
    || typeof source.resumable !== 'boolean' || !isIsoTimestamp(source.updatedAt)
    || !isJsonValue(data) || !isJsonValue(progress)) return malformed(rpcName)
  return {
    version,
    phase: source.phase,
    data: data as JsonObject,
    progress: progress as JsonObject,
    resumable: source.resumable,
    leaseVersion,
    updatedAt: source.updatedAt,
  }
}

function usageOf(value: unknown, rpcName: string): JobUsage {
  if (value == null) return {
    wallTimeMs: 0,
    rawTokens: 0,
    weightedTokens: 0,
    costMicros: 0,
    sandboxTimeMs: 0,
    toolCalls: 0,
  }
  const source = objectOf(value)
  const wallTimeMs = integerOf(source?.wallTimeMs)
  const rawTokens = integerOf(source?.rawTokens)
  const weightedTokens = integerOf(source?.weightedTokens)
  const costMicros = integerOf(source?.costMicros)
  const sandboxTimeMs = integerOf(source?.sandboxTimeMs)
  const toolCalls = integerOf(source?.toolCalls)
  if (!source || [wallTimeMs, rawTokens, weightedTokens, costMicros, sandboxTimeMs, toolCalls]
    .some(entry => entry === null || entry < 0)) return malformed(rpcName)
  return {
    wallTimeMs: wallTimeMs as number,
    rawTokens: rawTokens as number,
    weightedTokens: weightedTokens as number,
    costMicros: costMicros as number,
    sandboxTimeMs: sandboxTimeMs as number,
    toolCalls: toolCalls as number,
  }
}

function parseJob(value: unknown, rpcName: string): JobRecord {
  const source = objectOf(value)
  if (!source) return malformed(rpcName)
  const principal = objectOf(source.principal)
  const principalId = principal?.id ?? source.principalId
  const authClass = principal?.authClass ?? source.authClass
  const status = statusOf(source.status)
  const attempt = integerOf(source.attempt)
  const maxAttempts = integerOf(source.maxAttempts)
  const priority = integerOf(source.priority)
  const leaseSource = objectOf(source.lease)
  const leaseOwner = leaseSource?.owner ?? source.leaseOwner
  const leaseVersion = leaseSource?.version ?? source.leaseVersion
  const leaseExpiresAt = leaseSource?.expiresAt ?? source.leaseExpiresAt
  const parsedLeaseVersion = integerOf(leaseVersion)
  const validAuth = authClass === 'anonymous' || authClass === 'registered' || authClass === 'service'
  if (!isJobIdentifier(source.id) || typeof source.type !== 'string' || typeof source.queue !== 'string'
    || !isJobIdentifier(principalId) || !validAuth || !status || attempt === null
    || maxAttempts === null || priority === null || !isIsoTimestamp(source.availableAt)
    || !isIsoTimestamp(source.createdAt) || !isIsoTimestamp(source.updatedAt)) return malformed(rpcName)
  const hasLease = leaseOwner != null || leaseExpiresAt != null
  if ((hasLease && (!isJobIdentifier(leaseOwner) || parsedLeaseVersion === null
      || parsedLeaseVersion < 1 || !isIsoTimestamp(leaseExpiresAt)))
    || (!hasLease && (parsedLeaseVersion === null || parsedLeaseVersion < 0))) return malformed(rpcName)
  return {
    id: source.id,
    type: source.type,
    queue: source.queue,
    principal: { id: principalId, authClass: authClass as JobAuthClass },
    subject: jsonObjectOf(source.subject),
    inputHash: typeof source.inputHash === 'string' ? source.inputHash : '',
    input: jsonObjectOf(source.input ?? source.payload),
    status,
    attempt,
    maxAttempts,
    priority,
    availableAt: source.availableAt,
    budget: jsonObjectOf(source.budget) as JobBudget,
    usage: usageOf(source.usage, rpcName),
    checkpoint: checkpointOf(source.checkpoint, rpcName),
    result: source.result == null ? null : jsonOf(source.result, null),
    error: failureOf(source),
    lease: hasLease ? {
      owner: leaseOwner as string,
      version: parsedLeaseVersion as number,
      expiresAt: leaseExpiresAt as string,
    } : null,
    cancelRequestedAt: source.cancelRequestedAt == null
      ? null
      : isIsoTimestamp(source.cancelRequestedAt) ? source.cancelRequestedAt : malformed(rpcName),
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
    terminalAt: source.terminalAt == null
      ? null
      : isIsoTimestamp(source.terminalAt) ? source.terminalAt : malformed(rpcName),
  }
}

export class SupabaseJobRepository implements JobRepository {
  private readonly dependencies: SupabaseJobRepositoryDependencies

  constructor(dependencies: Partial<SupabaseJobRepositoryDependencies> = {}) {
    this.dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencies }
  }

  private client(): SupabaseClient {
    let client: SupabaseClient | null
    try {
      client = this.dependencies.createAdminClient()
    } catch (error) {
      throw new JobRuntimeError('JOB_DEPENDENCY_UNAVAILABLE', 'Job repository is unavailable', { cause: error })
    }
    if (!client) throw new JobRuntimeError('JOB_DEPENDENCY_UNAVAILABLE', 'Job repository is unavailable')
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
            reject(new JobRuntimeError('JOB_TIMEOUT', 'Job repository operation timed out', {
              details: { rpc: name },
            }))
          }, this.dependencies.rpcTimeoutMs)
        }),
      ])
      if (response.error) {
        log.error('jobs', 'Job repository RPC failed', { rpc: name, code: response.error.code })
        throw new JobRuntimeError('JOB_DEPENDENCY_UNAVAILABLE', 'Job repository operation failed', {
          details: { rpc: name, ...(response.error.code ? { databaseCode: response.error.code } : {}) },
        })
      }
      return rpcObject(response.data) ?? malformed(name)
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  }

  async enqueue(input: Parameters<JobRepository['enqueue']>[0]) {
    assertEnqueueJobInput(input)
    const result = await this.rpc('enqueue_job', {
      input_job_id: input.jobId,
      input_type: input.type,
      input_queue: input.queue,
      input_principal_id: input.principal.id,
      input_auth_class: input.principal.authClass,
      input_subject: input.subject,
      input_idempotency_key: input.idempotencyKey,
      input_input_hash: input.inputHash,
      input_payload: input.input,
      input_budget: input.budget ?? {},
      input_priority: input.priority ?? 0,
      input_max_attempts: input.maxAttempts ?? 3,
      ...(input.availableAt ? { input_available_at: input.availableAt } : {}),
    })
    if (result.enqueued !== true && result.replayed !== true) return malformed('enqueue_job')
    return { created: result.enqueued === true && result.replayed !== true, job: parseJob(result.job, 'enqueue_job') }
  }

  async claim(input: Parameters<JobRepository['claim']>[0]): Promise<JobClaimResult> {
    if (!isJobIdentifier(input.workerId) || input.queues.length < 1
      || input.queues.length > JOB_LIMITS.workerConcurrencyMaximum
      || input.queues.some(queue => typeof queue !== 'string' || queue.length > JOB_LIMITS.queueLength)
      || !Number.isSafeInteger(input.leaseSeconds)
      || input.leaseSeconds < JOB_LIMITS.leaseSecondsMinimum
      || input.leaseSeconds > JOB_LIMITS.leaseSecondsMaximum) {
      throw new JobRuntimeError('JOB_INVALID_INPUT', 'Invalid job claim input')
    }
    const result = await this.rpc('claim_next_job', {
      input_worker_id: input.workerId,
      input_queues: [...input.queues],
      input_lease_seconds: input.leaseSeconds,
    })
    if (result.acquired !== true) {
      const reason = result.reason === 'active' || result.reason === 'attempts_exhausted'
        ? result.reason
        : 'empty'
      return { acquired: false, reason, job: null }
    }
    return { acquired: true, reason: 'claimed', job: parseJob(result.job, 'claim_next_job') }
  }

  async renew(input: Parameters<JobRepository['renew']>[0]): Promise<JobRenewResult> {
    assertJobFence(input)
    try {
      const result = await this.rpc('renew_job_lease', {
        input_job_id: input.jobId,
        input_worker_id: input.workerId,
        input_lease_version: input.leaseVersion,
        input_lease_seconds: input.leaseSeconds,
      })
      return {
        state: result.renewed === true ? 'renewed' : 'lost',
        status: statusOf(result.status),
        leaseExpiresAt: result.leaseExpiresAt == null ? null
          : isIsoTimestamp(result.leaseExpiresAt) ? result.leaseExpiresAt : malformed('renew_job_lease'),
        cancelRequested: result.cancelRequested === true,
      }
    } catch (error) {
      if (error instanceof JobRuntimeError
        && (error.code === 'JOB_DEPENDENCY_UNAVAILABLE' || error.code === 'JOB_TIMEOUT')) {
        return { state: 'unavailable', status: null, leaseExpiresAt: null, cancelRequested: false }
      }
      throw error
    }
  }

  async retry(input: Parameters<JobRepository['retry']>[0]) {
    return retrySupabaseJob(input, (name, args) => this.rpc(name, args))
  }

  async appendEvents(input: Parameters<JobRepository['appendEvents']>[0]): Promise<JobEventsMutationResult> {
    assertJobFence(input)
    assertJobEvents(input.events)
    const result = await this.rpc('append_job_events', {
      input_job_id: input.jobId,
      input_worker_id: input.workerId,
      input_lease_version: input.leaseVersion,
      input_events: input.events.map(event => ({
        schemaVersion: event.schemaVersion ?? JOB_EVENT_SCHEMA_VERSION,
        kind: event.kind,
        payload: event.payload,
        ...(event.idempotencyKey ? { idempotencyKey: event.idempotencyKey } : {}),
      })),
    })
    return {
      accepted: result.appended === true,
      replayed: result.replayed === true,
      status: statusOf(result.status),
      fromSeq: nullableInteger(result.fromSeq),
      toSeq: nullableInteger(result.toSeq),
      cancelRequested: result.cancelRequested === true,
    }
  }

  async checkpointWithAccounting(
    input: Parameters<JobRepository['checkpointWithAccounting']>[0],
  ) {
    return checkpointSupabaseJobWithAccounting(input, (name, args) => this.rpc(name, args))
  }

  async recordAccounting(input: Parameters<JobRepository['recordAccounting']>[0]) {
    return recordSupabaseJobAccounting(input, (name, args) => this.rpc(name, args))
  }

  async resume(input: Parameters<JobRepository['resume']>[0]) {
    return resumeSupabaseJob(input, (name, args) => this.rpc(name, args))
  }

  async finalize(input: Parameters<JobRepository['finalize']>[0]): Promise<JobFinalizeResult> {
    assertJobFence(input)
    const result = await this.rpc('finalize_job', {
      input_job_id: input.jobId,
      input_worker_id: input.workerId,
      input_lease_version: input.leaseVersion,
      input_status: input.status,
      input_result: input.result ?? null,
      input_error_class: input.error?.class ?? null,
      input_error_code: input.error?.code ?? null,
      input_ledger_entries: input.ledgerEntries ?? [],
      input_outbox: input.outbox ?? [],
    })
    const status = statusOf(result.status)
    if (!isTerminalJobStatus(status)) return malformed('finalize_job')
    return {
      accepted: result.finalized === true,
      replayed: result.replayed === true,
      status,
      result: result.result == null ? null : jsonOf(result.result, null),
      error: failureOf(result),
      eventSeq: nullableInteger(result.eventSeq),
    }
  }

  async cancel(input: Parameters<JobRepository['cancel']>[0]) {
    if (!isJobIdentifier(input.jobId) || !isJobIdentifier(input.principalId)) {
      throw new JobRuntimeError('JOB_INVALID_INPUT', 'Invalid job cancellation input')
    }
    const result = await this.rpc('cancel_job', {
      input_job_id: input.jobId,
      input_principal_id: input.principalId,
      input_reason: input.reason ?? null,
    })
    const status = statusOf(result.status)
    if (!status) return malformed('cancel_job')
    return {
      accepted: result.accepted === true,
      replayed: result.replayed === true,
      status,
      result: result.result == null ? null : jsonOf(result.result, null),
      eventSeq: nullableInteger(result.eventSeq),
    }
  }
}
