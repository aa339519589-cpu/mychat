import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { CodeConsoleView, type CodeConsoleViewProps } from '../components/code-console/view'
import { MessageView } from '../components/code-console/message-view'

function props(overrides: Partial<CodeConsoleViewProps> = {}): CodeConsoleViewProps {
  return {
    userId: 'user-1',
    onExit: () => {},
    connected: true,
    login: 'architect',
    repos: [],
    repo: null,
    entered: true,
    hiddenRepos: [],
    onLoadRepos: () => {},
    onEnterRepo: () => {},
    onHideRepo: () => {},
    onResetHiddenRepos: () => {},
    ghMenu: false,
    onOpenGhMenu: () => {},
    onCloseGhMenu: () => {},
    onDisconnect: () => {},
    onLeaveRepo: () => {},
    auto: false,
    onToggleAuto: () => {},
    scrollRef: { current: null },
    messages: [],
    streaming: false,
    applying: false,
    currentTaskId: null,
    workspaceDirty: false,
    publishPending: false,
    applyError: null,
    onDismissApplyError: () => {},
    onPublishWorkspacePR: () => {},
    pendingPlan: [],
    onAbandonPlan: () => {},
    onApplyPlan: () => {},
    input: '',
    onInputChange: () => {},
    onSubmit: () => {},
    onStopAgent: () => {},
    onCommand: () => {},
    overlay: null,
    onCloseOverlay: () => {},
    tier: '正构',
    onChangeTier: () => {},
    onLoadSession: () => {},
    ...overrides,
  }
}

function renderView(overrides: Partial<CodeConsoleViewProps> = {}): string {
  return renderToStaticMarkup(createElement(CodeConsoleView, props(overrides)))
}

test('Code Console always announces apply failures outside action panels', () => {
  const html = renderView({ applyError: '持久化失败，请重试' })

  assert.match(html, /role="alert"[^>]*>[\s\S]*持久化失败，请重试/)
  assert.match(html, /aria-label="关闭错误提示"/)
  assert.match(html, /for="code-task-input"/)
  assert.match(html, /id="code-task-input"/)
  assert.match(html, /<button[^>]*class="[^"]*size-11/)
  assert.match(html, /focus-visible:ring-2/)
  assert.doesNotMatch(html, /确认发布|确认并执行/)
})

test('Code Console action bars use responsive 44px controls', () => {
  const publish = renderView({
    repo: 'owner/project',
    currentTaskId: 'task-1',
    workspaceDirty: true,
  })
  assert.match(publish, /sm:flex-row/)
  assert.match(publish, /<button[^>]*class="[^"]*min-h-11[^>]*>[\s\S]*确认发布/)

  const plan = renderView({
    pendingPlan: [{ kind: 'create_repo', name: 'project' }],
  })
  assert.match(plan, /<button[^>]*class="[^"]*min-h-11[^>]*>[\s\S]*放弃/)
  assert.match(plan, /确认并执行/)
})

test('Code message links are filtered again at render time', () => {
  const unsafe = renderToStaticMarkup(createElement(MessageView, {
    login: 'architect',
    message: {
      id: 'message-1',
      role: 'assistant',
      content: '',
      result: {
        mode: 'direct_push',
        repoUrl: 'javascript:alert(1)',
        pagesUrl: 'https://user:password@example.com/',
      },
    },
  }))
  assert.doesNotMatch(unsafe, /<a\b|javascript:|user:password/)

  const safe = renderToStaticMarkup(createElement(MessageView, {
    login: 'architect',
    message: {
      id: 'message-2',
      role: 'assistant',
      content: '',
      steps: [{ kind: 'read', label: '读取 README' }],
      result: {
        mode: 'direct_push',
        repoUrl: 'https://github.com/owner/project',
      },
    },
  }))
  assert.match(safe, /href="https:\/\/github\.com\/owner\/project"/)
  assert.match(safe, /rel="noopener noreferrer"/)
  assert.match(safe, /aria-expanded="false"/)
  assert.match(safe, /aria-controls=/)
  assert.match(safe, /min-h-11/)
})
