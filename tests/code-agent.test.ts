import test from 'node:test'
import assert from 'node:assert/strict'
import { modelContent, type CodeMessage } from '../lib/code-data'
import { codeContinuationPrompt, isCodeUserBlocker } from '../lib/agent/continuation'
import { inferPublishPendingFromMessages, isFalseCodePause, isStaleRunningCodeTask, shouldShowWorkspacePublish } from '../lib/code-agent-ui'
import { enablePages, mergePullRequest } from '../lib/github'
import { getWorkspaceDiff, searchWorkspaceFiles, workspaceRoot } from '../lib/agent/workspace'
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'

test('execution receipts are returned to the next model turn', () => {
  const message: CodeMessage = {
    id: 'receipt-1',
    role: 'assistant',
    content: '',
    taskId: 'task-1',
    result: {
      repo: 'owner/project',
      commitSha: 'abc123',
      pagesUrl: 'https://owner.github.io/project/',
      pagesStatus: 'ready',
    },
  }
  const content = modelContent(message)
  assert.match(content, /平台执行回执/)
  assert.match(content, /owner\/project/)
  assert.match(content, /abc123/)
  assert.match(content, /Pages 状态：ready/)
})

test('Code Agent continues dirty workspaces but stops after publish', () => {
  const base = {
    workspace: true,
    usedTools: true,
    hasChanges: true,
    published: false,
    completed: false,
    waitingForUser: false,
    plannedRepo: false,
    plannedFiles: 0,
  }
  assert.match(codeContinuationPrompt(base) ?? '', /继续自主检查/)
  assert.equal(codeContinuationPrompt({ ...base, published: true }), null)
  assert.match(codeContinuationPrompt({ ...base, hasChanges: false }) ?? '', /complete/)
  assert.equal(codeContinuationPrompt({ ...base, hasChanges: false, completed: true }), null)
  assert.equal(codeContinuationPrompt({ ...base, hasChanges: false, waitingForUser: true }), null)
})

test('new projects cannot stop before repo and files are planned', () => {
  const base = {
    workspace: false,
    usedTools: false,
    hasChanges: false,
    published: false,
    completed: false,
    waitingForUser: false,
    plannedRepo: true,
    plannedFiles: 0,
  }
  assert.match(codeContinuationPrompt(base) ?? '', /完整计划/)
  assert.equal(codeContinuationPrompt({ ...base, plannedFiles: 3 }), null)
})

test('Code Agent cannot pause for work it can do itself', () => {
  assert.equal(isCodeUserBlocker('要继续吗？', '还需要安装依赖、构建验证和修复'), false)
  assert.equal(isCodeUserBlocker('请让我继续', '下一步需要发布上线'), false)
  assert.equal(isCodeUserBlocker('请重新授权 GitHub', '当前授权失效，无法读取私有仓库'), true)
  assert.equal(isCodeUserBlocker('请选择保留旧版还是采用新版', '两个产品方案互斥，需要你决定'), true)
})

test('Pages is ready only after GitHub reports built and the URL responds', { concurrency: false }, async t => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (init?.method === 'POST') {
      return Response.json({ html_url: 'https://owner.github.io/project/' }, { status: 201 })
    }
    if (url.startsWith('https://api.github.com/')) {
      return Response.json({ status: 'built', html_url: 'https://owner.github.io/project/' })
    }
    return new Response('ok', { status: 200 })
  }

  assert.deepEqual(
    await enablePages('token', 'owner/project', 'main', { timeoutMs: 0, intervalMs: 0 }),
    { status: 'ready', url: 'https://owner.github.io/project/' },
  )
})

test('Pages reports pending instead of claiming deployment succeeded', { concurrency: false }, async t => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  globalThis.fetch = async (_input, init) => {
    if (init?.method === 'POST') return Response.json({}, { status: 201 })
    return Response.json({ status: 'building' })
  }

  assert.deepEqual(
    await enablePages('token', 'owner/project', 'main', { timeoutMs: 0, intervalMs: 0 }),
    { status: 'pending', url: 'https://owner.github.io/project/' },
  )
})

test('website publishing merges the exact PR head through GitHub', { concurrency: false }, async t => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), 'https://api.github.com/repos/owner/project/pulls/7/merge')
    assert.equal(init?.method, 'PUT')
    assert.deepEqual(JSON.parse(String(init?.body)), { sha: 'head-sha', merge_method: 'merge' })
    return Response.json({ merged: true, sha: 'merge-sha' })
  }

  assert.deepEqual(
    await mergePullRequest('token', 'owner/project', 7, 'head-sha'),
    { merged: true, commitSha: 'merge-sha' },
  )
})

test('publish button stays visible after agent asks for confirmation', () => {
  const messages: CodeMessage[] = [
    { id: '1', role: 'user', content: '继续做完' },
    { id: '2', role: 'assistant', content: '改动已就绪，等待用户确认发布。\n\n请点击底部「确认发布」按钮。' },
  ]

  assert.equal(inferPublishPendingFromMessages(messages), true)
  assert.equal(
    shouldShowWorkspacePublish(
      { status: 'waiting_for_user', pullRequestUrl: null, steps: [{ kind: 'deploy', label: '准备发布' }] },
      messages,
      false,
    ),
    true,
  )
})

test('publish button hides after publish receipt arrives', () => {
  const messages: CodeMessage[] = [
    { id: '1', role: 'assistant', content: '改动已就绪，等待用户确认发布。' },
    {
      id: '2',
      role: 'assistant',
      content: '',
      result: {
        mode: 'workspace_pr',
        commitSha: 'abc123',
        pullRequestUrl: 'https://github.com/owner/repo/pull/1',
      },
    },
  ]

  assert.equal(inferPublishPendingFromMessages(messages), false)
  assert.equal(
    shouldShowWorkspacePublish(
      { status: 'creating_pr', pullRequestUrl: 'https://github.com/owner/repo/pull/1', steps: [{ kind: 'deploy', label: '准备发布' }] },
      messages,
      false,
    ),
    false,
  )
})

test('unfinished pauses and stale running tasks are resumed', () => {
  const unfinished: CodeMessage[] = [
    { id: '1', role: 'assistant', content: '还需要安装依赖、构建验证和修复问题，请让我继续。' },
  ]
  assert.equal(isFalseCodePause('waiting_for_user', unfinished), true)
  assert.equal(isFalseCodePause('completed', unfinished), false)
  assert.equal(isStaleRunningCodeTask('running', '2026-06-24T00:00:00.000Z', Date.parse('2026-06-24T00:01:00.000Z')), true)
  assert.equal(isStaleRunningCodeTask('running', '2026-06-24T00:00:30.000Z', Date.parse('2026-06-24T00:01:00.000Z')), false)
})

test('workspace search returns line locations and diff includes new files', t => {
  const taskId = `search-${Date.now()}`
  const userId = 'test-user'
  const root = workspaceRoot(taskId, userId)
  t.after(() => rmSync(root, { recursive: true, force: true }))

  mkdirSync(`${root}/src`, { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: root })
  writeFileSync(`${root}/src/app.ts`, 'const marker = "Agent permission"\n')

  const search = searchWorkspaceFiles(taskId, userId, 'agent permission')
  assert.equal(search.ok, true)
  if (search.ok) assert.deepEqual(search.data.matches, ['src/app.ts:1: const marker = "Agent permission"'])

  const diff = getWorkspaceDiff(taskId, userId)
  assert.match(diff, /\+\+\+ b\/src\/app\.ts/)
  assert.match(diff, /Agent permission/)
})
