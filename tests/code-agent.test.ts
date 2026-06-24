import test from 'node:test'
import assert from 'node:assert/strict'
import { modelContent, type CodeMessage } from '../lib/code-data'
import { codeContinuationPrompt } from '../lib/agent/continuation'
import { enablePages, mergePullRequest } from '../lib/github'

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
