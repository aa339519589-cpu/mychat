import type { SupabaseClient } from '@/lib/supabase/types'
import type { JobAuthClass, JobBudget, JobStatus, JsonObject } from '@/lib/jobs/contracts'
import type { JobRepository } from '@/lib/jobs/repository'
import {
  readOwnedJob,
  readOwnedJobEvents,
  type PublicJobEvent,
  type PublicJobSnapshot,
} from '@/lib/jobs/read-model'

export type WorkflowStartCommand = {
  executionId: string
  workflowName: string
  taskQueue: string
  actor: { id: string; authClass: JobAuthClass }
  target: JsonObject
  deduplicationKey: string
  inputDigest: string
  input: JsonObject
  limits?: JobBudget
  priority?: number
  maxAttempts?: number
  availableAt?: string
}

export type WorkflowExecution = {
  executionId: string
  workflowName: string
  state: JobStatus
  created: boolean
}

export type WorkflowSnapshot = Omit<PublicJobSnapshot, 'id' | 'type' | 'status'> & {
  executionId: string
  workflowName: string
  state: JobStatus
}

export type WorkflowEvent = Omit<PublicJobEvent, 'jobId'> & { executionId: string }

export type WorkflowReadResult<T> =
  | { ok: true; value: T }
  | { ok: false; kind: 'not_found' | 'unavailable' | 'malformed' }

export type WorkflowMutationResult = {
  accepted: boolean
  replayed: boolean
  state: JobStatus | null
  reason?: string | null
}

export interface WorkflowRuntime {
  start(command: WorkflowStartCommand): Promise<WorkflowExecution>
  cancel(command: {
    executionId: string
    actorId: string
    reason?: string
  }): Promise<WorkflowMutationResult>
  signal(command: {
    executionId: string
    actorId: string
    signalName: string
    signalId: string
    expectedVersion: number
    payload: JsonObject
  }): Promise<WorkflowMutationResult>
  status(query: {
    executionId: string
    actorId: string
    signal?: AbortSignal
  }): Promise<WorkflowReadResult<WorkflowSnapshot>>
  events(query: {
    executionId: string
    actorId: string
    afterSequence: number
    limit?: number
    signal?: AbortSignal
  }): Promise<WorkflowReadResult<WorkflowEvent[]>>
}

type PostgresWorkflowRuntimeDependencies = {
  repository: JobRepository
  client: SupabaseClient
  readJob?: typeof readOwnedJob
  readEvents?: typeof readOwnedJobEvents
}

function snapshot(value: PublicJobSnapshot): WorkflowSnapshot {
  const { id, type, status, ...rest } = value
  return { ...rest, executionId: id, workflowName: type, state: status }
}

function event(value: PublicJobEvent): WorkflowEvent {
  const { jobId, ...rest } = value
  return { ...rest, executionId: jobId }
}

export class PostgresWorkflowRuntime implements WorkflowRuntime {
  private readonly repository: JobRepository
  private readonly client: SupabaseClient
  private readonly readJob: typeof readOwnedJob
  private readonly readEvents: typeof readOwnedJobEvents

  constructor(dependencies: PostgresWorkflowRuntimeDependencies) {
    this.repository = dependencies.repository
    this.client = dependencies.client
    this.readJob = dependencies.readJob ?? readOwnedJob
    this.readEvents = dependencies.readEvents ?? readOwnedJobEvents
  }

  async start(command: WorkflowStartCommand): Promise<WorkflowExecution> {
    const result = await this.repository.enqueue({
      jobId: command.executionId,
      type: command.workflowName,
      queue: command.taskQueue,
      principal: command.actor,
      subject: command.target,
      idempotencyKey: command.deduplicationKey,
      inputHash: command.inputDigest,
      input: command.input,
      budget: command.limits,
      priority: command.priority,
      maxAttempts: command.maxAttempts,
      availableAt: command.availableAt,
    })
    return {
      executionId: result.job.id,
      workflowName: result.job.type,
      state: result.job.status,
      created: result.created,
    }
  }

  async cancel(command: {
    executionId: string
    actorId: string
    reason?: string
  }): Promise<WorkflowMutationResult> {
    const result = await this.repository.cancel({
      jobId: command.executionId,
      principalId: command.actorId,
      reason: command.reason,
    })
    return { accepted: result.accepted, replayed: result.replayed, state: result.status }
  }

  async signal(command: {
    executionId: string
    actorId: string
    signalName: string
    signalId: string
    expectedVersion: number
    payload: JsonObject
  }): Promise<WorkflowMutationResult> {
    if (command.signalName !== 'resume') throw new TypeError('Unsupported workflow signal')
    const result = await this.repository.resume({
      jobId: command.executionId,
      principalId: command.actorId,
      expectedCheckpointVersion: command.expectedVersion,
      idempotencyKey: command.signalId,
      resumeInput: command.payload,
    })
    return {
      accepted: result.accepted,
      replayed: result.replayed,
      state: result.status,
      reason: result.reason,
    }
  }

  async status(query: {
    executionId: string
    actorId: string
    signal?: AbortSignal
  }): Promise<WorkflowReadResult<WorkflowSnapshot>> {
    const result = await this.readJob(this.client, query.actorId, query.executionId, query.signal)
    return result.ok ? { ok: true, value: snapshot(result.value) } : result
  }

  async events(query: {
    executionId: string
    actorId: string
    afterSequence: number
    limit?: number
    signal?: AbortSignal
  }): Promise<WorkflowReadResult<WorkflowEvent[]>> {
    const result = await this.readEvents(
      this.client,
      query.actorId,
      query.executionId,
      query.afterSequence,
      query.limit,
      query.signal,
    )
    return result.ok ? { ok: true, value: result.value.map(event) } : result
  }
}
