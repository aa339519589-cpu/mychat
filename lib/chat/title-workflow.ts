import type { SupabaseClient } from '@/lib/supabase/types'
import { sha256JobValue } from '@/lib/jobs/canonical'
import type { EnqueueJobInput, JobAuthClass, JobStatus, JsonObject } from '@/lib/jobs/contracts'
import type { JobRepository } from '@/lib/jobs/repository'
import { SupabaseJobRepository } from '@/lib/jobs/supabase-repository'
import { jobMetrics } from '@/lib/observability/job-metrics'
import { workflowRuntimeMode, type WorkflowRuntimeMode } from '@/lib/workflows/config'
import {
  PostgresWorkflowRuntime,
  type WorkflowRuntime,
  type WorkflowStartCommand,
} from '@/lib/workflows/runtime'

export type StartTitleWorkflowInput = {
  client: SupabaseClient
  userId: string
  authClass: JobAuthClass
  conversationId: string
  sourceMessageId: string
  endpointId?: string
  usingBalance: boolean
}

type StartTitleWorkflowDependencies = {
  createExecutionId: () => string
  runtimeMode: () => WorkflowRuntimeMode
  createRepository: () => JobRepository
  createRuntime: (client: SupabaseClient) => Pick<WorkflowRuntime, 'start'>
  recordEnqueued: () => void
}

const DEFAULT_DEPENDENCIES: StartTitleWorkflowDependencies = {
  createExecutionId: () => crypto.randomUUID(),
  runtimeMode: workflowRuntimeMode,
  createRepository: () => new SupabaseJobRepository(),
  createRuntime: client => new PostgresWorkflowRuntime({
    repository: new SupabaseJobRepository(),
    client,
  }),
  recordEnqueued: () => jobMetrics.recordEnqueued('title'),
}

function titlePayload(input: StartTitleWorkflowInput): JsonObject {
  return {
    schemaVersion: 1,
    usingBalance: input.usingBalance,
    billingClass: input.endpointId ? 'customer' : 'platform',
    ...(input.endpointId ? { endpointId: input.endpointId } : {}),
  }
}

function workflowCommand(
  input: StartTitleWorkflowInput,
  executionId: string,
  payload: JsonObject,
): WorkflowStartCommand {
  return {
    executionId,
    workflowName: 'chat.title',
    taskQueue: 'title',
    actor: { id: input.userId, authClass: input.authClass },
    target: { conversationId: input.conversationId, sourceMessageId: input.sourceMessageId },
    deduplicationKey: `title:${input.conversationId}:${input.sourceMessageId}`,
    inputDigest: sha256JobValue(payload),
    input: payload,
    limits: { wallTimeMs: 60_000, tokenLimit: 8_192 },
    maxAttempts: 3,
  }
}

function legacyCommand(command: WorkflowStartCommand): EnqueueJobInput {
  return {
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
  }
}

export async function startTitleWorkflow(
  input: StartTitleWorkflowInput,
  dependencyOverrides: Partial<StartTitleWorkflowDependencies> = {},
): Promise<{ executionId: string; state: JobStatus; created: boolean }> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides }
  const command = workflowCommand(input, dependencies.createExecutionId(), titlePayload(input))
  let result: { executionId: string; state: JobStatus; created: boolean }
  if (dependencies.runtimeMode() === 'postgres-v1') {
    const started = await dependencies.createRuntime(input.client).start(command)
    result = { executionId: started.executionId, state: started.state, created: started.created }
  } else {
    const started = await dependencies.createRepository().enqueue(legacyCommand(command))
    result = { executionId: started.job.id, state: started.job.status, created: started.created }
  }
  if (result.created) dependencies.recordEnqueued()
  return result
}
