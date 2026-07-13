import assert from 'node:assert/strict'
import test from 'node:test'
import { parseCodeChatRequest } from '../lib/code-agent/request'
import {
  createCodeEventCollector,
  createCodeRunProgress,
  finalCodeTaskStatus,
} from '../lib/code-agent/runtime'

test('code chat request applies stable defaults and keeps recovery messages', () => {
  const parsed = parseCodeChatRequest({
    messages: [{ role: 'user', content: '修复测试' }],
    resumeMessages: [{ role: 'tool', content: 'done' }],
  })

  assert.equal(parsed.repo, null)
  assert.equal(parsed.tier, '正构')
  assert.equal(parsed.taskId, null)
  assert.deepEqual(parsed.resumeMessages, [{ role: 'tool', content: 'done' }])
})

test('code chat request rejects invalid repositories and message roles', () => {
  assert.throws(
    () => parseCodeChatRequest({ repo: 'owner/repo/extra', messages: [{ role: 'user', content: 'x' }] }),
    /仓库参数无效/,
  )
  assert.throws(
    () => parseCodeChatRequest({ messages: [{ role: 'system', content: 'x' }] }),
    /消息格式或角色无效/,
  )
})

test('code chat request enforces per-message and aggregate context limits', () => {
  assert.throws(
    () => parseCodeChatRequest({ messages: [{ role: 'user', content: 'x'.repeat(100_001) }] }),
    /单条消息过长/,
  )
  assert.throws(
    () => parseCodeChatRequest({
      messages: Array.from({ length: 21 }, () => ({ role: 'user', content: 'x'.repeat(100_000) })),
    }),
    /消息上下文过大/,
  )
})

test('code event collector releases plain final text when no progress occurred', () => {
  const sent: object[] = []
  const collector = createCodeEventCollector({ send: event => sent.push(event) })

  collector.emit({ text: '最终答复' })
  collector.emit({ thinking: '隐藏推理' })
  assert.deepEqual(sent, [])
  assert.equal(collector.flushLeadText(), '最终答复')
  assert.deepEqual(sent, [{ text: '最终答复' }])
})

test('code event collector drops lead-in after progress and preserves SSE ordering', () => {
  const sent: object[] = []
  const steps: string[] = []
  const collector = createCodeEventCollector({
    send: event => sent.push(event),
    recordStep: (kind, label) => steps.push(`${kind}:${label}`),
  })

  collector.emit({ text: '让我先看看。' })
  collector.emit({ step: { kind: 'read', label: '读取 route.ts' } })
  collector.emit({ text: '修改完成' })

  assert.equal(collector.flushLeadText(), '修改完成')
  assert.deepEqual(sent, [
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
