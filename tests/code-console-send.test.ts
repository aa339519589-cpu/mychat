import assert from 'node:assert/strict'
import test from 'node:test'
import type { Dispatch, SetStateAction } from 'react'
import {
  executeCodeSend,
  type CodeSendContext,
  type CodeSendDependencies,
} from '../components/code-console/send'
import type { JobStreamEnvelope } from '../components/literary-chat/job-stream-client'
import { provisionalRepositoryForSession } from '../lib/code-agent/provisional-repository'
import type { CodeMessage, PlanAction } from '../lib/code-data'

function stateDispatch<T>(initial: T) {
  let current = initial
  const dispatch: Dispatch<SetStateAction<T>> = action => {
    current = typeof action === 'function'
      ? (action as (previous: T) => T)(current)
      : action
  }
  return { dispatch, current: () => current }
}

function event(kind: string, payload: Record<string, unknown>, seq: number): JobStreamEnvelope {
  return { jobId: 'job-1', kind, payload, seq }
}

function harness(options: {
  repo?: string | null
  sessionId?: string | null
  messages?: CodeMessage[]
  auto?: boolean
} = {}) {
  const initialMessages = options.messages ?? []
  const messages = stateDispatch<CodeMessage[]>(initialMessages)
  const streaming = stateDispatch(false)
  const applyError = stateDispatch<string | null>(null)
  const workspaceDirty = stateDispatch(true)
  const sessionId = stateDispatch<string | null>(options.sessionId ?? null)
  const taskId = stateDispatch<string | null>(null)
  const publishPending = stateDispatch(false)
  const pendingPlan = stateDispatch<PlanAction[]>([])
  const calls = { apply: 0, sync: [] as string[] }
  const abortRef: { current: AbortController | null } = { current: null }
  const context: CodeSendContext = {
    userId: 'user-1',
    repo: options.repo === undefined ? 'owner/repo' : options.repo,
    messages: initialMessages,
    streaming: false,
    currentTaskId: null,
    sessionId: options.sessionId ?? null,
    tier: '正构',
    auto: options.auto ?? false,
    abortRef,
    setMessages: messages.dispatch,
    setStreaming: streaming.dispatch,
    setApplyError: applyError.dispatch,
    setWorkspaceDirty: workspaceDirty.dispatch,
    setSessionId: sessionId.dispatch,
    setCurrentTaskId: taskId.dispatch,
    setPublishPending: publishPending.dispatch,
    setPendingPlan: pendingPlan.dispatch,
    applyPlan: async () => { calls.apply++ },
    syncWorkspaceState: async id => { calls.sync.push(id) },
  }
  return {
    context,
    calls,
    state: { messages, streaming, applyError, workspaceDirty, sessionId, taskId, publishPending, pendingPlan },
  }
}

function identifiers(): () => string {
  const values = ['assistant-1', 'user-message-1']
  return () => values.shift() ?? 'unexpected-id'
}

test('code send persists both visible roles and binds the created session to the Job', async () => {
  const fixture = harness()
  const inserted: Array<{ sessionId: string; message: CodeMessage }> = []
  let enqueueBody: unknown
  let touched = ''
  const dependencies: Partial<CodeSendDependencies> = {
    randomId: identifiers(),
    createSession: async () => 'session-1',
    insertMessage: async (_userId, sessionId, message) => { inserted.push({ sessionId, message }) },
    touchSession: async sessionId => { touched = sessionId },
    enqueue: async (_path, body) => {
      enqueueBody = body
      return { jobId: 'job-1', streamUrl: '/stream/job-1', status: 'queued' }
    },
    stream: async function* () {
      yield event('job.started', { taskId: 'task-1' }, 1)
      yield event('text.delta', { text: 'completed' }, 2)
      yield event('job.terminal', { status: 'completed', result: { content: 'completed' } }, 3)
    },
  }

  await executeCodeSend('fix it', undefined, fixture.context, dependencies)

  assert.deepEqual(inserted.map(entry => entry.message.role), ['user', 'assistant'])
  assert.equal(inserted[1]?.message.content, 'completed')
  assert.equal(inserted[1]?.message.taskId, 'task-1')
  assert.equal((enqueueBody as { sessionId?: string }).sessionId, 'session-1')
  assert.equal(fixture.state.sessionId.current(), 'session-1')
  assert.equal(fixture.state.taskId.current(), 'task-1')
  assert.deepEqual(fixture.calls.sync, ['task-1'])
  assert.equal(touched, 'session-1')
  assert.equal(fixture.state.streaming.current(), false)
  assert.equal(fixture.context.abortRef.current, null)
})

test('internal continuation is sent to the model but never persisted as a visible user message', async () => {
  const baseMessages: CodeMessage[] = [
    { id: 'visible-user', role: 'user', content: 'build it' },
    { id: 'receipt', role: 'assistant', content: 'repository created' },
  ]
  const fixture = harness({ sessionId: 'session-existing', messages: baseMessages })
  const inserted: CodeMessage[] = []
  let modelMessages: unknown
  const dependencies: Partial<CodeSendDependencies> = {
    randomId: identifiers(),
    createSession: async () => { throw new Error('must not create') },
    insertMessage: async (_userId, _sessionId, message) => { inserted.push(message) },
    touchSession: async () => {},
    enqueue: async (_path, body) => {
      modelMessages = (body as { messages?: unknown }).messages
      return { jobId: 'job-1', streamUrl: '/stream/job-1', status: 'queued' }
    },
    stream: async function* () {
      yield event('job.terminal', { status: 'completed', result: { content: 'continued' } }, 1)
    },
  }

  await executeCodeSend('hidden platform instruction', {
    internal: true,
    baseMessages,
  }, fixture.context, dependencies)

  assert.equal((modelMessages as unknown[]).length, 3)
  assert.deepEqual(inserted.map(message => [message.role, message.content]), [['assistant', 'continued']])
  assert.deepEqual(fixture.state.messages.current().map(message => message.content), [
    'build it',
    'repository created',
    'continued',
  ])
})

test('new-project mode can plan before a repository-backed session exists', async () => {
  const fixture = harness({ repo: null })
  const sessionId = '60000000-0000-4000-8000-000000000001'
  let createCalls = 0
  let insertCalls = 0
  let enqueueBody: unknown
  const dependencies: Partial<CodeSendDependencies> = {
    randomId: identifiers(),
    createSession: async (_userId, repo) => {
      createCalls++
      assert.equal(repo, null)
      return sessionId
    },
    insertMessage: async () => { insertCalls++ },
    touchSession: async () => {},
    enqueue: async (_path, body) => {
      enqueueBody = body
      return { jobId: 'job-1', streamUrl: '/stream/job-1', status: 'queued' }
    },
    stream: async function* () {
      yield event('job.started', { taskId: 'planning-task' }, 1)
      yield event('agent.plan', { plan: { kind: 'create_repo', name: 'new-app' } }, 2)
      yield event('job.terminal', { status: 'completed', result: { content: 'plan ready' } }, 3)
    },
  }

  await executeCodeSend('make a new app', undefined, fixture.context, dependencies)

  assert.equal(createCalls, 1)
  assert.equal(insertCalls, 2)
  assert.equal((enqueueBody as { repo?: string }).repo, provisionalRepositoryForSession(sessionId))
  assert.equal(fixture.state.messages.current().at(-1)?.content, 'plan ready')
  assert.deepEqual(fixture.state.pendingPlan.current(), [{ kind: 'create_repo', name: 'new-app' }])
  assert.equal(fixture.state.taskId.current(), null)
})

test('code send fails before enqueue when a required repository session cannot persist', async () => {
  const fixture = harness()
  let enqueueCalls = 0
  await executeCodeSend('fix it', undefined, fixture.context, {
    randomId: identifiers(),
    createSession: async () => null,
    enqueue: async () => {
      enqueueCalls++
      return { jobId: 'job-1', streamUrl: '/stream/job-1', status: 'queued' }
    },
  })

  assert.equal(enqueueCalls, 0)
  assert.match(fixture.state.messages.current().at(-1)?.content ?? '', /无法创建代码会话/)
  assert.equal(fixture.state.messages.current().at(-1)?.isError, true)
  assert.equal(fixture.state.streaming.current(), false)
})

test('stream failures preserve partial output and persist the authoritative error state', async () => {
  const fixture = harness({ sessionId: 'session-existing' })
  const inserted: CodeMessage[] = []
  await executeCodeSend('fix it', undefined, fixture.context, {
    randomId: identifiers(),
    insertMessage: async (_userId, _sessionId, message) => { inserted.push(message) },
    touchSession: async () => {},
    enqueue: async () => ({ jobId: 'job-1', streamUrl: '/stream/job-1', status: 'queued' }),
    stream: async function* () {
      yield event('text.delta', { text: 'partial' }, 1)
      throw new Error('offline')
    },
  })

  const expected = 'partial\n\n请求失败：offline'
  assert.equal(fixture.state.messages.current().at(-1)?.content, expected)
  assert.equal(fixture.state.messages.current().at(-1)?.isError, true)
  assert.equal(inserted.at(-1)?.content, expected)
  assert.equal(inserted.at(-1)?.isError, true)
})
