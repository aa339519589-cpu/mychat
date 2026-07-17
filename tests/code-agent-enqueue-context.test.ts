import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CodeAgentEnqueueContextError,
  parseAgentEnqueueResult,
  resolveCodeAgentEnqueueContext,
} from '../lib/code-agent/enqueue-context'
import {
  isProvisionalRepositoryForSession,
  provisionalRepositoryForSession,
} from '../lib/code-agent/provisional-repository'

const TASK_ID = '71000000-0000-4000-8000-000000000001'
const SESSION_ID = '71000000-0000-4000-8000-000000000002'
const MESSAGE_ID = '71000000-0000-4000-8000-000000000003'
const JOB_ID = '71000000-0000-4000-8000-000000000004'
const REPO = 'owner/project'

function query(data: unknown, error: unknown = null) {
  return { data, error }
}

function context(overrides: Partial<Parameters<typeof resolveCodeAgentEnqueueContext>[0]> = {}) {
  return {
    task: query(null),
    session: query({ id: SESSION_ID, repo: REPO }),
    userMessage: query({ id: MESSAGE_ID, session_id: SESSION_ID }),
    taskId: TASK_ID,
    sessionId: SESSION_ID,
    repo: REPO,
    ...overrides,
  }
}

function assertContextError(
  input: Parameters<typeof resolveCodeAgentEnqueueContext>[0],
  kind: CodeAgentEnqueueContextError['kind'],
): void {
  assert.throws(
    () => resolveCodeAgentEnqueueContext(input),
    error => error instanceof CodeAgentEnqueueContextError && error.kind === kind,
  )
}

test('enqueue context accepts both new and active existing tasks', () => {
  assert.deepEqual(resolveCodeAgentEnqueueContext(context()), { userMessageId: MESSAGE_ID })
  assert.deepEqual(resolveCodeAgentEnqueueContext(context({
    task: query({ id: TASK_ID, repo: REPO, status: 'running' }),
  })), { userMessageId: MESSAGE_ID })
})

test('enqueue context binds a provisional repository to its durable session', () => {
  const repo = provisionalRepositoryForSession(SESSION_ID)
  assert.deepEqual(resolveCodeAgentEnqueueContext(context({
    repo,
    session: query({ id: SESSION_ID, repo }),
  })), { userMessageId: MESSAGE_ID })
})

test('enqueue context rejects task, session, message, and repository mismatches', () => {
  assertContextError(context({
    task: query({ id: '71000000-0000-4000-8000-000000000009', repo: REPO, status: 'running' }),
  }), 'conflict')
  assertContextError(context({
    session: query({ id: '71000000-0000-4000-8000-000000000009', repo: REPO }),
  }), 'conflict')
  assertContextError(context({
    userMessage: query({ id: MESSAGE_ID, session_id: '71000000-0000-4000-8000-000000000009' }),
  }), 'conflict')
  assertContextError(context({
    task: query({ id: TASK_ID, repo: 'owner/other', status: 'running' }),
  }), 'conflict')
})

test('enqueue context rejects terminal tasks', () => {
  for (const status of ['completed', 'cancelled']) {
    assertContextError(context({ task: query({ id: TASK_ID, repo: REPO, status }) }), 'terminal')
  }
})

test('enqueue context distinguishes dependency failures and malformed records', () => {
  assertContextError(context({ task: query(null, new Error('query failed')) }), 'dependency')
  assertContextError(context({ task: query({ id: TASK_ID, repo: REPO, status: 'unknown' }) }), 'dependency')
  assertContextError(context({ session: query({ id: SESSION_ID }) }), 'dependency')
  assertContextError(context({ userMessage: query({ id: MESSAGE_ID }) }), 'dependency')
})

test('agent enqueue result strictly parses creation and replay responses', () => {
  const job = { id: JOB_ID, status: 'queued' }
  assert.deepEqual(parseAgentEnqueueResult({ enqueued: true, replayed: false, job }, null), {
    jobId: JOB_ID,
    status: 'queued',
    created: true,
  })
  assert.deepEqual(parseAgentEnqueueResult([{ enqueued: false, replayed: true, job }], null), {
    jobId: JOB_ID,
    status: 'queued',
    created: false,
  })

  for (const data of [
    { enqueued: true, replayed: true, job },
    { enqueued: false, replayed: false, job },
    { enqueued: true, replayed: false, job: { id: JOB_ID, status: 'unknown' } },
    [],
    [{ enqueued: true, replayed: false, job }, { enqueued: false, replayed: true, job }],
  ]) {
    assert.equal(parseAgentEnqueueResult(data, null), null)
  }
  assert.equal(parseAgentEnqueueResult({ enqueued: true, replayed: false, job }, new Error('rpc')), null)
})

test('provisional repository markers normalize valid UUIDs and reject spoofing', () => {
  const uppercaseSession = SESSION_ID.toUpperCase()
  const marker = `__mychat_new__/${SESSION_ID}`
  assert.equal(provisionalRepositoryForSession(uppercaseSession), marker)
  assert.equal(isProvisionalRepositoryForSession(marker, SESSION_ID), true)
  assert.equal(isProvisionalRepositoryForSession(marker, '71000000-0000-4000-8000-000000000009'), false)
  assert.equal(isProvisionalRepositoryForSession(`__mychat_new__/${TASK_ID}`, SESSION_ID), false)
  assert.equal(isProvisionalRepositoryForSession(`owner/${SESSION_ID}`, SESSION_ID), false)

  for (const invalid of ['', 'not-a-uuid', '71000000-0000-6000-8000-000000000002']) {
    assert.throws(() => provisionalRepositoryForSession(invalid), /Invalid provisional Code session id/)
    assert.equal(isProvisionalRepositoryForSession(marker, invalid), false)
  }
})
