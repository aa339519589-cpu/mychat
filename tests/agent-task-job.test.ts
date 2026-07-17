import assert from 'node:assert/strict'
import test from 'node:test'
import type { SupabaseClient } from '../lib/supabase/types'
import type { JobAccounting } from '../lib/jobs/repository'
import type { JobEventDraft, JsonObject } from '../lib/jobs/contracts'
import type { JobExecutionContext } from '../lib/jobs/worker'
import { JobRuntimeError } from '../lib/jobs/errors'
import { JobEventWriter } from '../lib/jobs/event-writer'
import { createCodeEventCollector, type CodeProgressSnapshot } from '../lib/code-agent/runtime'
import type { ChatEvent } from '../lib/llm/events'
import type { LoadedAgentJob } from '../lib/jobs/handlers/agent-input'
import { createAgentRuntime } from '../lib/jobs/handlers/agent-runtime'
import {
  runAgentTaskJob,
  type AgentTaskDependencies,
} from '../lib/jobs/handlers/agent'

const JOB_ID = '73000000-0000-4000-8000-000000000001'
const TASK_ID = '73000000-0000-4000-8000-000000000002'
const SESSION_ID = '73000000-0000-4000-8000-000000000003'
const RESPONSE_ID = '73000000-0000-4000-8000-000000000004'

function agentInput(): LoadedAgentJob {
  return {
    client: {} as SupabaseClient,
    userId: '73000000-0000-4000-8000-000000000005',
    taskId: TASK_ID,
    repo: null,
    sessionId: SESSION_ID,
    responseId: RESPONSE_ID,
    userMessageId: '73000000-0000-4000-8000-000000000006',
    messages: [{ role: 'user', content: '创建一个专业项目' }],
    token: 'test-token',
    login: 'architect',
    defaultBranch: null,
    repoIsPrivate: false,
    memories: [],
    workspaceReady: false,
    model: 'deepseek-chat',
    thinking: false,
    usingBalance: false,
  }
}

function executionContext(checkpoint: JobExecutionContext['job']['checkpoint'] = null) {
  const order: string[] = []
  const events: JobEventDraft[] = []
  const checkpoints: Array<{ phase: string; checkpoint: JsonObject; progress?: JsonObject }> = []
  const accounting: JobAccounting[] = []
  const value = {
    job: {
      id: JOB_ID,
      checkpoint,
      usage: {
        wallTimeMs: 0,
        rawTokens: 0,
        weightedTokens: 0,
        costMicros: 0,
        sandboxTimeMs: 0,
        toolCalls: 0,
      },
    },
    fence: { jobId: JOB_ID, workerId: 'worker-1', leaseVersion: 2 },
    signal: new AbortController().signal,
    budget: {},
    assertAuthority() {},
    reportAccounting(entry: JobAccounting) {
      order.push('accounting.report')
      accounting.push(entry)
    },
    async flushAccounting() { order.push('accounting.flush') },
    async appendEvents(batch: readonly JobEventDraft[]) {
      order.push(`events:${batch.map(event => event.kind).join(',')}`)
      events.push(...batch)
    },
    async checkpoint(input: { phase: string; checkpoint: JsonObject; progress?: JsonObject }) {
      order.push('checkpoint')
      checkpoints.push(input)
    },
  } as unknown as JobExecutionContext
  return { value, order, events, checkpoints, accounting }
}

const WAITING_PROGRESS: CodeProgressSnapshot = {
  workspace: false,
  usedTools: true,
  hasChanges: false,
  published: false,
  completed: false,
  waitingForUser: true,
  plannedRepo: true,
  plannedFiles: 1,
}

function runtimeFactory(
  order: string[],
  artifacts: Array<{ content?: string; meta?: Record<string, unknown> }>,
): AgentTaskDependencies['createRuntime'] {
  return (_context, _input, writer) => {
    const events = createCodeEventCollector({
      send: event => writer.emit(event as ChatEvent),
    })
    return {
      recorder: {
        async setTaskStatus(status: string) { order.push(`status:${status}`) },
        async artifact(_kind: string, artifact: { content?: string; meta?: Record<string, unknown> }) {
          order.push('artifact')
          artifacts.push(artifact)
        },
      },
      canExecute: false,
      tools: [],
      events,
      progress: { snapshot: () => WAITING_PROGRESS },
      executeTool: async () => '',
    } as unknown as ReturnType<typeof createAgentRuntime>
  }
}

test('agent Job durably preserves plan output and flushes accounting before checkpoint', async () => {
  const context = executionContext()
  const artifacts: Array<{ content?: string; meta?: Record<string, unknown> }> = []
  let savedMessages = 0
  const result = await runAgentTaskJob(context.value, agentInput(), {
    apiKey: () => 'test-key',
    createRuntime: runtimeFactory(context.order, artifacts),
    runLoop: async options => {
      assert.match(String(options.messages[0]?.content), /Plan 模式/)
      options.emit({
        plan: {
          kind: 'create_repo',
          name: 'professional-app',
          description: 'A durable app',
          private: false,
        },
      })
      options.emit({ text: '计划已经准备好。' })
      await options.onUsage?.(12)
      options.messages.push({ role: 'assistant', content: '计划已经准备好。' })
      await options.onCheckpoint?.(options.messages)
      return { totalTokens: 12 }
    },
    saveRunState: async (_client, _userId, _taskId, state) => {
      context.order.push('run-state')
      savedMessages = state.resumeMessages?.length ?? 0
    },
  })

  assert.equal(result.status, 'completed')
  assert.equal((result.result as { content?: string }).content, '计划已经准备好。')
  assert.equal((result.result as { taskStatus?: string }).taskStatus, 'waiting_for_user')
  assert.equal(result.ledgerEntries?.[0]?.rawTokens, 12)
  assert.equal(context.accounting[0]?.rawTokens, 12)
  assert.ok(context.order.indexOf('accounting.flush') < context.order.indexOf('checkpoint'))
  assert.ok(context.order.indexOf('checkpoint') < context.order.indexOf('artifact'))
  assert.equal(context.events[0]?.kind, 'job.started')
  assert.ok(context.events.some(event => event.kind === 'agent.plan'))
  assert.ok(context.events.some(event => event.kind === 'text.delta'))
  assert.equal(context.checkpoints[0]?.progress?.totalTokens, 12)
  assert.equal(savedMessages, 1)
  assert.equal(artifacts[0]?.content, '计划已经准备好。')
  assert.equal(artifacts[0]?.meta?.plannedRepo, true)
})

test('agent Job refuses an explicitly non-resumable checkpoint before provider work', async () => {
  const context = executionContext({
    version: 1,
    phase: 'agent.model_round',
    data: {},
    progress: {},
    resumable: false,
    leaseVersion: 1,
    updatedAt: '2026-07-17T00:00:00.000Z',
  })
  let providerCalls = 0
  await assert.rejects(
    runAgentTaskJob(context.value, agentInput(), {
      apiKey: () => 'test-key',
      createRuntime: runtimeFactory(context.order, []),
      runLoop: async () => { providerCalls++; return { totalTokens: 0 } },
    }),
    error => error instanceof JobRuntimeError && error.code === 'JOB_RETRY_UNSAFE',
  )
  assert.equal(providerCalls, 0)
})

test('repository-less planning never exposes workspace-only or unusable execute tools', {
  concurrency: false,
}, t => {
  const previous = process.env.E2B_API_KEY
  process.env.E2B_API_KEY = 'configured-for-test'
  t.after(() => {
    if (previous === undefined) delete process.env.E2B_API_KEY
    else process.env.E2B_API_KEY = previous
  })
  const context = executionContext()
  const runtime = createAgentRuntime(
    context.value,
    agentInput(),
    new JobEventWriter(context.value),
  )
  const names = runtime.tools.map(tool => tool.function.name)

  assert.equal(runtime.canExecute, false)
  assert.ok(names.includes('create_repo'))
  assert.ok(names.includes('write_files'))
  assert.ok(names.includes('enable_pages'))
  for (const unavailable of ['execute', 'apply_patch', 'search_files', 'git_diff', 'verify', 'publish']) {
    assert.equal(names.includes(unavailable), false)
  }
})
