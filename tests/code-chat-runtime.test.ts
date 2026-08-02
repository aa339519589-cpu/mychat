import assert from 'node:assert/strict'
import test from 'node:test'
import { provisionalRepositoryForSession } from '../lib/code-agent/provisional-repository'
import { parseCodeChatRequest } from '../lib/code-agent/request'
import {
  createCodeEventCollector,
  createCodeRunProgress,
  finalCodeTaskStatus,
} from '../lib/code-agent/runtime'

const MODEL_ID = 'openai/gpt-5.6-sol'

function requestBody(extra: Record<string, unknown> = {}) {
  return {
    modelId: MODEL_ID,
    messages: [{ role: 'user', content: '修复测试' }],
    ...extra,
  }
}

test('code chat request preserves the selected model', () => {
  const parsed = parseCodeChatRequest(requestBody())

  assert.equal(parsed.repo, null)
  assert.equal(parsed.modelId, MODEL_ID)
  assert.equal(parsed.reasoningEffort, undefined)
  assert.equal(parsed.taskId, null)
})

test('code chat request rejects invalid repositories and message roles', () => {
  assert.throws(
    () => parseCodeChatRequest(requestBody({ repo: 'owner/repo/extra' })),
    /仓库参数无效/,
  )
  const sessionId = '60000000-0000-4000-8000-000000000001'
  assert.equal(parseCodeChatRequest(requestBody({
    repo: provisionalRepositoryForSession(sessionId),
    sessionId,
    messages: [{ role: 'user', content: 'new project' }],
  })).repo, provisionalRepositoryForSession(sessionId))
  assert.throws(
    () => parseCodeChatRequest(requestBody({
      repo: '__mychat_new__/60000000-0000-4000-8000-000000000002',
      sessionId,
      messages: [{ role: 'user', content: 'x' }],
    })),
    /仓库参数无效/,
  )
  assert.throws(
    () => parseCodeChatRequest(requestBody({ messages: [{ role: 'system', content: 'x' }] })),
    /消息格式或角色无效/,
  )
})

test('code chat request enforces per-message and aggregate context limits', () => {
  assert.throws(
    () => parseCodeChatRequest(requestBody({ messages: [{ role: 'user', content: 'x'.repeat(100_001) }] })),
    /单条消息过长/,
  )
  assert.throws(
    () => parseCodeChatRequest(requestBody({
      messages: Array.from({ length: 21 }, () => ({ role: 'user', content: 'x'.repeat(100_000) })),
    })),
    /消息上下文过大/,
  )
})

test('code event collector forwards plain final text immediately', () => {
  const sent: object[] = []
  const collector = createCodeEventCollector({ send: event => sent.push(event) })

  collector.emit({ text: '最终答复' })
  collector.emit({ thinking: '隐藏推理' })

  assert.deepEqual(sent, [{ text: '最终答复' }])
  assert.equal(collector.flushLeadText(), '最终答复')
})

test('code event collector preserves visible text and SSE ordering around progress', () => {
  const sent: object[] = []
  const steps: string[] = []
  const collector = createCodeEventCollector({
    send: event => sent.push(event),
    recordStep: (kind, label) => steps.push(`${kind}:${label}`),
  })

  collector.emit({ text: '让我先看看。' })
  collector.emit({ step: { kind: 'read', label: '读取 route.ts' } })
  collector.emit({ text: '修改完成' })

  assert.equal(collector.flushLeadText(), '让我先看看。修改完成')
  assert.deepEqual(sent, [
    { text: '让我先看看。' },
    { step: { kind: 'read', label: '读取 route.ts' } },
    { text: '修改完成' },
  ])
  assert.deepEqual(steps, ['read:读取 route.ts'])
})

test('code run progress and terminal status expose tool state without route globals', () => {
  let changed = false
  const progress = createCodeRunProgress(() => changed)
  progress.toolState.markUsedTool()
  progress.toolState.markPlannedRepo()
  progress.toolState.addPlannedFiles(2)
  progress.toolState.markPublishCalled()
  changed = true

  const snapshot = progress.snapshot(true)
  assert.deepEqual(snapshot, {
    workspace: true,
    usedTools: true,
    hasChanges: true,
    published: true,
    completed: false,
    waitingForUser: false,
    plannedRepo: true,
    plannedFiles: 2,
  })
  assert.equal(finalCodeTaskStatus(false, snapshot), 'waiting_for_user')
  assert.equal(finalCodeTaskStatus(true, snapshot), 'failed')
  progress.toolState.markCompleted()
  assert.equal(finalCodeTaskStatus(false, progress.snapshot(true)), 'completed')
})
