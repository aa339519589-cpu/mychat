import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { WorkspacePanel } from '../components/agent-tasks/workspace-panel'
import type { WorkspaceActions } from '../components/agent-tasks/use-workspace-actions'
import type { AgentTaskDetail } from '../lib/agent/types'

function createDetail(pullRequestUrl: string | null = null): AgentTaskDetail {
  return {
    id: 'task-1',
    userId: 'user-1',
    goal: 'Harden the workspace panel',
    mode: 'pr',
    repo: 'acme/mychat',
    branch: 'main',
    status: 'running',
    error: null,
    meta: null,
    createdAt: '2026-07-17T00:00:00.000Z',
    updatedAt: '2026-07-17T00:00:00.000Z',
    startedAt: '2026-07-17T00:00:00.000Z',
    finishedAt: null,
    agentBranch: 'codex/task-1',
    pullRequestUrl,
    pullRequestNumber: 7,
    commitSha: null,
    steps: [],
    toolCalls: [],
    artifacts: [],
    workspace: {
      id: 'workspace-1',
      taskId: 'task-1',
      userId: 'user-1',
      repo: 'acme/mychat',
      branch: 'codex/task-1',
      commitSha: '0123456789abcdef',
      path: '/tmp/workspace-1',
      status: 'ready',
      createdAt: '2026-07-17T00:00:00.000Z',
      updatedAt: '2026-07-17T00:00:00.000Z',
    },
  }
}

function createActions(overrides: Partial<WorkspaceActions> = {}): WorkspaceActions {
  return {
    confirming: false,
    detectedCmds: null,
    diffLoading: false,
    fetchCommands: async () => {},
    fetchDiff: async () => {},
    gitStatus: null,
    lastSnapshotId: null,
    pendingConf: null,
    publish: async () => {},
    publishing: false,
    publishResult: null,
    restore: async () => {},
    restoring: false,
    restoreResult: null,
    setShowDiff: () => {},
    setShowVerify: () => {},
    showDiff: false,
    showVerify: false,
    snapshotCount: 0,
    verify: async () => {},
    verifyLoading: false,
    verifyResult: null,
    wsDiff: null,
    confirm: async () => {},
    reject: async () => {},
    ...overrides,
  }
}

function render(detail: AgentTaskDetail, actions: WorkspaceActions): string {
  return renderToStaticMarkup(createElement(WorkspacePanel, { detail, actions }))
}

test('workspace panel preserves accessible controls and announces failures', () => {
  const html = render(createDetail(), createActions({
    gitStatus: { ok: false, error: 'Git unavailable' },
    restoreResult: { ok: false, error: 'Snapshot corrupt' },
  }))

  assert.match(html, /<button[^>]*class="[^"]*min-h-11/)
  assert.match(html, /aria-expanded="false"/)
  assert.match(html, /aria-controls="workspace-diff"/)
  assert.match(html, /aria-controls="workspace-verification"/)
  assert.match(html, /role="alert"[^>]*>Snapshot corrupt/)
  assert.match(html, /role="alert"[^>]*>Git unavailable/)
})

test('workspace panel renders only safe PR links with isolated opener state', () => {
  const safeUrl = 'https://github.com/acme/mychat/pull/7'
  const safeHtml = render(createDetail(safeUrl), createActions({
    publishResult: { ok: true, pr: { pullRequestUrl: safeUrl } },
  }))

  assert.equal(safeHtml.match(new RegExp(`href="${safeUrl}"`, 'g'))?.length, 2)
  assert.equal(safeHtml.match(/rel="noopener noreferrer"/g)?.length, 2)

  const unsafeHtml = render(createDetail('javascript:alert(1)'), createActions({
    publishResult: { ok: true, pr: { pullRequestUrl: 'https://user:pass@example.com/pr/7' } },
  }))
  assert.doesNotMatch(unsafeHtml, /javascript:|user:pass|<a\b/)
})
