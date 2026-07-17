import { typedRpc, type RpcArgs, type SupabaseClient } from '@/lib/supabase/types'
import { toJson } from '@/lib/supabase/json'
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
  isTerminalJobStatus,
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
  failureOf, jsonOf, malformed, nullableInteger, objectOf, statusOf,
} from './supabase-parsing'
import { parseJobRecord } from './supabase-job-record'

export { parseJobRecord } from './supabase-job-record'

const DEFAULT_RPC_TIMEOUT_MS = 8_000

export type SupabaseJobRepositoryDependencies = {
  createAdminClient: () => SupabaseClient | null
  rpcTimeoutMs: number
}

const DEFAULT_DEPENDENCIES: SupabaseJobRepositoryDependencies = {
  createAdminClient,
  rpcTimeoutMs: DEFAULT_RPC_TIMEOUT_MS,
}

type JobRpcName =
  | 'enqueue_job'
  | 'claim_next_job'
  | 'renew_job_lease'
  | 'retry_job'
  | 'append_job_events'
  | 'checkpoint_job_with_accounting'
  | 'record_job_accounting'
  | 'resume_awaiting_job'
  | 'finalize_job'
  | 'cancel_job'

function rpcObject(value: unknown): Record<string, unknown> | null {
  return objectOf(Array.isArray(value) ? value[0] : value)
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

  private async rpc<Name extends JobRpcName>(
    name: Name,
    args: RpcArgs<Name>,
  ): Promise<Record<string, unknown>> {
    const controller = new AbortController()
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      const raw = typedRpc(this.client(), name, args)
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
    return { created: result.enqueued === true && result.replayed !== true, job: parseJobRecord(result.job, 'enqueue_job') }
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
    return { acquired: true, reason: 'claimed', job: parseJobRecord(result.job, 'claim_next_job') }
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
      input_ledger_entries: toJson([...(input.ledgerEntries ?? [])]),
      input_outbox: toJson([...(input.outbox ?? [])]),
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
