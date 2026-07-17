import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { EnqueueJobInput, JobRecord } from '../lib/jobs/contracts'
import { sha256JobValue } from '../lib/jobs/canonical'
import type { JobRepository } from '../lib/jobs/repository'
import { startTitleWorkflow } from '../lib/chat/title-workflow'
import { workflowRuntimeMode } from '../lib/workflows/config'
import type { WorkflowStartCommand } from '../lib/workflows/runtime'

const EXECUTION_ID = '40000000-0000-4000-8000-000000000001'
const input = {
  client: {} as SupabaseClient,
  userId: '40000000-0000-4000-8000-000000000002',
  authClass: 'registered' as const,
  conversationId: '40000000-0000-4000-8000-000000000003',
  sourceMessageId: '40000000-0000-4000-8000-000000000004',
  usingBalance: false,
}

function queued(command: EnqueueJobInput): JobRecord {
  const now = new Date().toISOString()
  return {
    id: command.jobId, type: command.type, queue: command.queue,
    principal: command.principal, subject: command.subject,
    inputHash: command.inputHash, input: command.input, status: 'queued', attempt: 0,
    maxAttempts: command.maxAttempts ?? 3, priority: command.priority ?? 0,
    availableAt: now, budget: command.budget ?? {},
    usage: { wallTimeMs: 0, rawTokens: 0, weightedTokens: 0, costMicros: 0, sandboxTimeMs: 0, toolCalls: 0 },
    checkpoint: null, result: null, error: null, lease: null, cancelRequestedAt: null,
    createdAt: now, updatedAt: now, terminalAt: null,
  }
}

test('title workflow defaults to the new adapter and validates rollback mode', () => {
  assert.equal(workflowRuntimeMode(undefined), 'postgres-v1')
  assert.equal(workflowRuntimeMode(' postgres-v1 '), 'postgres-v1')
  assert.equal(workflowRuntimeMode('legacy'), 'legacy')
  assert.throws(() => workflowRuntimeMode('unknown'), /must be postgres-v1 or legacy/)
})

test('title workflow adapter and legacy rollback preserve scheduling semantics', async () => {
  const workflows: WorkflowStartCommand[] = []
  const legacyCommands: EnqueueJobInput[] = []
  let metricCount = 0
  const common = {
    createExecutionId: () => EXECUTION_ID,
    recordEnqueued: () => { metricCount += 1 },
  }
  const modern = await startTitleWorkflow(input, {
    ...common,
    runtimeMode: () => 'postgres-v1',
    createRuntime: () => ({
      start: async command => {
        workflows.push(command)
        return { executionId: command.executionId, workflowName: command.workflowName, state: 'queued', created: true }
      },
    }),
  })
  const legacyRepository = {
    enqueue: async (command: EnqueueJobInput) => {
      legacyCommands.push(command)
      return { created: true, job: queued(command) }
    },
  } as JobRepository
  const rollback = await startTitleWorkflow(input, {
    ...common,
    runtimeMode: () => 'legacy',
    createRepository: () => legacyRepository,
  })

  assert.deepEqual(modern, { executionId: EXECUTION_ID, state: 'queued', created: true })
  assert.deepEqual(rollback, modern)
  assert.equal(metricCount, 2)
  const workflow = workflows[0]
  const legacy = legacyCommands[0]
  assert.ok(workflow)
  assert.ok(legacy)
  assert.deepEqual(legacy, {
    jobId: workflow.executionId,
    type: workflow.workflowName,
    queue: workflow.taskQueue,
    principal: workflow.actor,
    subject: workflow.target,
    idempotencyKey: workflow.deduplicationKey,
    inputHash: workflow.inputDigest,
    input: workflow.input,
    budget: workflow.limits,
    priority: workflow.priority,
    maxAttempts: workflow.maxAttempts,
    availableAt: workflow.availableAt,
  })
  assert.deepEqual(workflow.input, {
    schemaVersion: 1,
    usingBalance: false,
    billingClass: 'platform',
  })
  assert.equal(workflow.inputDigest, sha256JobValue({
    schemaVersion: 1,
    usingBalance: false,
    billingClass: 'platform',
  }))
})

test('chat title is wired route to runtime to the existing worker handler', () => {
  const route = readFileSync(new URL('../app/api/chat/title/route.ts', import.meta.url), 'utf8')
  const worker = readFileSync(new URL('../job-worker.ts', import.meta.url), 'utf8')
  assert.match(route, /startTitleWorkflow\(/)
  assert.doesNotMatch(route, /SupabaseJobRepository|\.enqueue\(/)
  assert.match(worker, /'chat\.title': measured\(handleChatTitle\)/)
})
