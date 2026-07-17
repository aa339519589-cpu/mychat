import assert from 'node:assert/strict'
import test from 'node:test'
import type { SupabaseClient } from '../lib/supabase/types'
import type { JobExecutionContext } from '../lib/jobs/worker'
import { provisionalRepositoryForSession } from '../lib/code-agent/provisional-repository'
import { loadAgentJob } from '../lib/jobs/handlers/agent-input'

const USER_ID = '74000000-0000-4000-8000-000000000001'
const TASK_ID = '74000000-0000-4000-8000-000000000002'
const SESSION_ID = '74000000-0000-4000-8000-000000000003'
const RESPONSE_ID = '74000000-0000-4000-8000-000000000004'
const MESSAGE_ID = '74000000-0000-4000-8000-000000000005'
const CREATED_AT = '2026-07-17T12:00:00.000Z'

function planClient(tables: string[]): SupabaseClient {
  class Query implements PromiseLike<{ data: unknown; error: null }> {
    constructor(
      private readonly table: string,
      private readonly projection: string,
    ) {}

    select(projection: string) { return new Query(this.table, projection) }
    eq() { return this }
    in() { return this }
    lte() { return this }
    order() { return this }
    limit() { return this }
    maybeSingle() {
      if (this.table === 'agent_tasks') return Promise.resolve({
        data: {
          id: TASK_ID,
          repo: provisionalRepositoryForSession(SESSION_ID),
          goal: 'new project',
          status: 'queued',
          agent_branch: null,
        },
        error: null,
      })
      return Promise.resolve({ data: { id: MESSAGE_ID, created_at: CREATED_AT }, error: null })
    }
    then<TResult1 = { data: unknown; error: null }, TResult2 = never>(
      onfulfilled?: ((value: { data: unknown; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): Promise<TResult1 | TResult2> {
      assert.equal(this.table, 'code_messages')
      assert.match(this.projection, /role,content/)
      return Promise.resolve({
        data: [{ id: MESSAGE_ID, role: 'user', content: 'build it', created_at: CREATED_AT }],
        error: null,
      }).then(onfulfilled, onrejected)
    }
  }

  return {
    from(table: string) {
      tables.push(table)
      if (table === 'code_memories') throw new Error('plan mode must not read repository memories')
      return new Query(table, '')
    },
  } as unknown as SupabaseClient
}

function context(): JobExecutionContext {
  return {
    job: {
      id: '74000000-0000-4000-8000-000000000006',
      principal: { id: USER_ID, authClass: 'registered' },
      subject: {
        taskId: TASK_ID,
        repo: provisionalRepositoryForSession(SESSION_ID),
        sessionId: SESSION_ID,
        responseId: RESPONSE_ID,
        userMessageId: MESSAGE_ID,
      },
      input: { tier: '正构' },
    },
    fence: {
      jobId: '74000000-0000-4000-8000-000000000006',
      workerId: 'worker-plan',
      leaseVersion: 1,
    },
    signal: new AbortController().signal,
  } as unknown as JobExecutionContext
}

test('provisional Agent input loads only durable chat and GitHub identity metadata', async () => {
  const tables: string[] = []
  let credentialCalls = 0
  let workspaceCalls = 0
  const input = await loadAgentJob(context(), {
    client: () => planClient(tables),
    githubIdentity: async () => ({ login: 'architect' }),
    credential: async () => {
      credentialCalls++
      throw new Error('credential must remain sealed during planning')
    },
    prepareWorkspace: async () => {
      workspaceCalls++
      throw new Error('workspace must not be prepared during planning')
    },
  })

  assert.equal(input.repo, null)
  assert.equal(input.token, '')
  assert.equal(input.login, 'architect')
  assert.equal(input.workspaceReady, false)
  assert.equal(input.defaultBranch, null)
  assert.deepEqual(input.memories, [])
  assert.deepEqual(input.messages, [{ role: 'user', content: 'build it' }])
  assert.equal(credentialCalls, 0)
  assert.equal(workspaceCalls, 0)
  assert.equal(tables.includes('code_memories'), false)
  assert.deepEqual(tables, ['agent_tasks', 'code_messages', 'code_messages'])
})
