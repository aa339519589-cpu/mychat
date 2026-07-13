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

function concurrency(name: string, fallback: number): number {
  const configured = Number(process.env[name] ?? fallback)
  if (!Number.isSafeInteger(configured) || configured < 1 || configured > 16) {
    throw new Error(`${name} must be an integer between 1 and 16`)
  }
  return configured
}

const baseWorkerId = process.env.JOB_WORKER_ID?.trim()
  || `${hostname()}:${process.pid}:${crypto.randomUUID()}`
const shutdown = new AbortController()

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
  { name: 'chat', queues: ['chat'], concurrency: concurrency('JOB_CHAT_CONCURRENCY', 2) },
  { name: 'media', queues: ['media'], concurrency: concurrency('JOB_MEDIA_CONCURRENCY', 1) },
  { name: 'title', queues: ['title'], concurrency: concurrency('JOB_TITLE_CONCURRENCY', 1) },
  { name: 'agent', queues: ['agent'], concurrency: concurrency('JOB_AGENT_CONCURRENCY', 1) },
] as const
const workers = workerSpecs.map(spec => new JobWorker({
  repository,
  workerId: `${baseWorkerId}:${spec.name}`,
  queues: spec.queues,
  handlers,
  concurrency: spec.concurrency,
  leaseSeconds: 120,
  renewIntervalMs: 2_000,
  shutdownGraceMs: 240_000,
  onFinalized: finalized,
}))
const outbox = new JobOutboxDispatcher({
  repository: new SupabaseJobOutboxRepository(),
  workerId: `${baseWorkerId}:outbox`,
  lockSeconds: 120,
})

async function main(): Promise<void> {
  assertProductionAgentSandbox()
  log.info('jobs', 'Worker pool started', { workerId: baseWorkerId, workers: workerSpecs })
  await Promise.all([
    ...workers.map(worker => worker.run(shutdown.signal)),
    outbox.run(shutdown.signal),
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
