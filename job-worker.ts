import { hostname } from 'node:os'
import { assertProductionAgentSandbox } from '@/lib/agent/execution-policy'
import { handleChatGeneration } from '@/lib/jobs/handlers/chat'
import { handleChatTitle } from '@/lib/jobs/handlers/title'
import { handleAgentTask } from '@/lib/jobs/handlers/agent'
import { handleAgentOperation } from '@/lib/jobs/handlers/agent-operation'
import { SupabaseJobRepository } from '@/lib/jobs/supabase-repository'
import { SupabaseJobOutboxRepository } from '@/lib/jobs/supabase-outbox'
import { JobOutboxDispatcher } from '@/lib/jobs/outbox-dispatcher'
import { JobWorker } from '@/lib/jobs/worker'
import { log } from '@/lib/logger'
import { jobMetrics, type JobMetricType } from '@/lib/observability/job-metrics'
import { normalizeJobError } from '@/lib/jobs/errors'
import type { JobHandler } from '@/lib/jobs/worker'
import { JobWorkerHeartbeat } from '@/lib/jobs/worker-heartbeat'
import { safeRevision } from '@/lib/supabase/health'
import { JobLifecycleSweeper } from '@/lib/jobs/lifecycle-sweeper'
import { BillingReconciliationMonitor } from '@/lib/jobs/billing-reconciliation'
import { resolveRuntimeConfiguration } from '@/lib/runtime-config'

const runtimeConfiguration = resolveRuntimeConfiguration(process.env, 'worker')
const baseWorkerId = runtimeConfiguration.workerId
  || `${hostname()}:${process.pid}:${crypto.randomUUID()}`
const shutdown = new AbortController()
const maintenanceMode = runtimeConfiguration.maintenanceMode

function metricType(job: { type: string; input: unknown }): JobMetricType {
  if (job.type === 'chat.title') return 'title'
  if (job.type === 'agent.task' || job.type === 'agent.operation') return 'agent_task'
  if (job.type === 'chat.generation' && job.input && typeof job.input === 'object' && !Array.isArray(job.input)) {
    const outputKind = (job.input as { outputKind?: unknown }).outputKind
    if (outputKind === 'image') return 'media_image'
    if (outputKind === 'video') return 'media_video'
  }
  return job.type === 'chat.generation' ? 'chat_generation' : 'other'
}

function measured(handler: JobHandler): JobHandler {
  return async context => {
    const type = metricType(context.job)
    const started = Date.now()
    jobMetrics.recordClaim(type, 'claimed')
    jobMetrics.observeQueueLatency(type, Math.max(0, started - Date.parse(context.job.createdAt)))
    try { return await handler(context) } catch (error) {
      const normalized = normalizeJobError(error)
      jobMetrics.recordProviderError(type, type === 'media_image' ? 'image'
        : type === 'media_video' ? 'video'
          : type === 'agent_task' ? 'sandbox'
            : type === 'chat_generation' || type === 'title' ? 'llm' : 'other', normalized.retryable)
      throw error
    }
  }
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    log.info('jobs', 'Worker shutdown requested', { workerId: baseWorkerId, signal })
    shutdown.abort(new Error(signal))
  })
}

const repository = new SupabaseJobRepository()
const handlers: Record<string, JobHandler> = {
  'chat.generation': measured(handleChatGeneration),
  'chat.title': measured(handleChatTitle),
  'agent.task': measured(handleAgentTask),
  'agent.operation': measured(handleAgentOperation),
}
const finalized: NonNullable<ConstructorParameters<typeof JobWorker>[0]['onFinalized']> = (
  { job, status, durationMs },
) => {
  const type = metricType(job)
  jobMetrics.recordTerminal(type, status)
  jobMetrics.observeRunDuration(type, status, durationMs)
}
const workerSpecs = [
  { name: 'chat', queue: 'chat', concurrency: runtimeConfiguration.workerConcurrency.chat },
  { name: 'media', queue: 'media', concurrency: runtimeConfiguration.workerConcurrency.media },
  { name: 'title', queue: 'title', concurrency: runtimeConfiguration.workerConcurrency.title },
  { name: 'agent', queue: 'agent', concurrency: runtimeConfiguration.workerConcurrency.agent },
] as const

function createWorker(
  spec: (typeof workerSpecs)[number],
  name: string,
  concurrency: number,
  hot = false,
): JobWorker {
  return new JobWorker({
    repository,
    workerId: `${baseWorkerId}:${name}`,
    queues: [spec.queue],
    handlers,
    concurrency,
    leaseSeconds: 120,
    shutdownGraceMs: 240_000,
    onFinalized: finalized,
    ...(hot ? {
      idleBackoffMinimumMs: 20,
      idleBackoffMaximumMs: 150,
      backoffJitter: 0.05,
    } : {}),
  })
}

const workerStartedAt = new Date().toISOString()
const heartbeat = new JobWorkerHeartbeat({
  workerId: baseWorkerId,
  revision: safeRevision(),
  queueCapacities: Object.fromEntries([
    ...workerSpecs.map(spec => [spec.queue, spec.concurrency] as const),
    ['outbox', 1] as const,
  ]),
  draining: maintenanceMode === 'drain',
  startedAt: workerStartedAt,
})
const workers = workerSpecs.flatMap(spec => {
  if (spec.queue !== 'chat') return [createWorker(spec, spec.name, spec.concurrency)]
  const hotWorker = createWorker(spec, 'chat-hot', 1, true)
  const remainingConcurrency = spec.concurrency - 1
  return remainingConcurrency > 0
    ? [hotWorker, createWorker(spec, 'chat-bulk', remainingConcurrency)]
    : [hotWorker]
})
const outbox = new JobOutboxDispatcher({
  repository: new SupabaseJobOutboxRepository(),
  workerId: `${baseWorkerId}:outbox`,
  lockSeconds: 120,
})
const lifecycleSweeper = new JobLifecycleSweeper()
const billingReconciliation = new BillingReconciliationMonitor()

async function main(): Promise<void> {
  assertProductionAgentSandbox()
  if (maintenanceMode === 'drain') {
    log.warn('jobs', 'Maintenance drain is active; Job and outbox claims are disabled', {
      workerId: baseWorkerId,
    })
    await Promise.all([
      heartbeat.run(shutdown.signal),
      billingReconciliation.run(shutdown.signal),
    ])
    return
  }
  log.info('jobs', 'Worker pool started', { workerId: baseWorkerId, workers: workerSpecs })
  await Promise.all([
    heartbeat.run(shutdown.signal),
    ...workers.map(worker => worker.run(shutdown.signal)),
    outbox.run(shutdown.signal),
    lifecycleSweeper.run(shutdown.signal),
    billingReconciliation.run(shutdown.signal),
  ])
  log.info('jobs', 'Worker pool stopped', { workerId: baseWorkerId })
}

void main().catch(error => {
  log.error('jobs', 'Worker stopped unexpectedly', {
    workerId: baseWorkerId,
    name: error instanceof Error ? error.name : 'unknown',
  })
  process.exitCode = 1
})
