import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import test from 'node:test'
import { createCodeRunProgress } from '../lib/code-agent/runtime'
import { createCodeToolExecutor } from '../lib/code-tools'
import type { ToolEvent } from '../lib/code-tools/definitions'
import { getWorkspaceDiff, workspaceRoot } from '../lib/agent/workspace'

type ExecutorOverrides = Partial<Parameters<typeof createCodeToolExecutor>[0]>

function executor(overrides: ExecutorOverrides = {}) {
  const events: ToolEvent[] = []
  const progress = createCodeRunProgress(() => false)
  const execute = createCodeToolExecutor({
    repo: null,
    login: 'architect',
    token: 'test-token',
    defaultBranch: null,
    repoIsPrivate: false,
    supabase: null,
    userId: null,
    wsReady: false,
    wsTaskId: 'unused-task',
    wsUserId: 'unused-user',
    tavilyApiKey: '',
    emit: event => events.push(event as ToolEvent),
    state: progress.toolState,
    canExecute: false,
    ...overrides,
  })
  return { events, execute, progress }
}

function temporaryWorkspace(t: test.TestContext) {
  const userId = `tool-user-${crypto.randomUUID()}`
  const taskId = `tool-task-${crypto.randomUUID()}`
  const root = workspaceRoot(taskId, userId)
  const snapshots = `/tmp/mychat-agent-snapshots/${userId}/${taskId}`
  mkdirSync(`${root}/src`, { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: root })
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: root })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root })
  writeFileSync(`${root}/src/app.ts`, 'export const marker = "needle"\n')
  writeFileSync(`${root}/patch.txt`, 'before\n')
  writeFileSync(`${root}/delete.txt`, 'remove me\n')
  execFileSync('git', ['add', '.'], { cwd: root })
  execFileSync('git', ['commit', '-qm', 'base'], { cwd: root })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  t.after(() => rmSync(snapshots, { recursive: true, force: true }))
  return { root, taskId, userId }
}

function workspaceExecutor(current: ReturnType<typeof temporaryWorkspace>) {
  const events: ToolEvent[] = []
  const progress = createCodeRunProgress(() => Boolean(getWorkspaceDiff(current.taskId, current.userId)))
  const execute = createCodeToolExecutor({
    repo: 'owner/repo',
    login: 'architect',
    token: 'test-token',
    defaultBranch: 'main',
    repoIsPrivate: false,
    supabase: null,
    userId: current.userId,
    wsReady: true,
    wsTaskId: current.taskId,
    wsUserId: current.userId,
    tavilyApiKey: '',
    emit: event => events.push(event as ToolEvent),
    state: progress.toolState,
    canExecute: false,
  })
  return { events, execute, progress }
}

test('non-workspace tools build a complete deterministic publication plan', async () => {
  const { events, execute, progress } = executor()

  assert.match(await execute('create_repo', {
    name: 'sample-app',
    description: 'A sample',
    private: true,
  }), /architect\/sample-app/)
  assert.match(await execute('write_files', {
    files: [
      { path: 'index.html', content: '<h1>Hello</h1>' },
      null,
      { path: '', content: 'ignored' },
    ],
  }), /3 个文件/)
  assert.match(await execute('delete_files', { paths: ['old.txt', '', null] }), /3 个文件/)
  assert.equal(await execute('enable_pages', {}), '已加入计划：开启 GitHub Pages。')

  const plans = events.flatMap(event => 'plan' in event ? [event.plan] : [])
  assert.deepEqual(plans, [
    { kind: 'create_repo', name: 'sample-app', description: 'A sample', private: true },
    { kind: 'write_file', path: 'index.html', oldContent: '', newContent: '<h1>Hello</h1>' },
    { kind: 'delete_file', path: 'old.txt' },
    { kind: 'enable_pages' },
  ])
  assert.deepEqual(progress.snapshot(false), {
    workspace: false,
    usedTools: true,
    hasChanges: false,
    published: false,
    completed: false,
    waitingForUser: false,
    plannedRepo: true,
    plannedFiles: 1,
  })
  assert.match(await execute('complete', {}), /明确标记为完成/)
  assert.equal(progress.snapshot(false).completed, true)
})

test('tool validation and policy gates fail early without external side effects', async () => {
  const fresh = executor()
  assert.equal(await fresh.execute('list_files', null), '尚未选择仓库。')
  assert.equal(await fresh.execute('search_files', { query: 'x' }), 'search_files 需要 workspace。')
  assert.equal(await fresh.execute('read_file', {}), '缺少 path。')
  assert.equal(await fresh.execute('read_file', { path: 'README.md' }), '尚未选择仓库。')
  assert.equal(await fresh.execute('create_repo', {}), '缺少仓库名。')
  assert.equal(await fresh.execute('write_files', {}), '没有要写的文件。')
  assert.equal(await fresh.execute('edit_file', { path: 'a', old_string: '' }), '缺少 path 或 old_string。')
  assert.equal(await fresh.execute('edit_file', {
    path: 'a', old_string: 'old', new_string: 'new',
  }), '尚未选择仓库。')
  assert.equal(await fresh.execute('execute', {}), '缺少 command。')
  assert.equal(await fresh.execute('execute', { command: 'npm test' }), '当前运行环境未启用命令执行。')
  assert.equal(await fresh.execute('verify', {}), '当前运行环境未启用项目验证。')
  assert.equal(await fresh.execute('apply_patch', {}), '缺少 patch 内容。')
  assert.match(await fresh.execute('apply_patch', { patch: 'diff --git a/a b/a' }), /需要 workspace/)
  assert.equal(await fresh.execute('git_diff', {}), 'git_diff 需要 workspace。')
  assert.match(await fresh.execute('publish', {}), /需要 workspace/)
  assert.equal(await fresh.execute('check_deployment', {}), '当前没有可检查的网页部署。')
  assert.equal(await fresh.execute('code_remember', {}), '内容为空。')
  assert.equal(await fresh.execute('search', {}), '查询为空。')
  assert.equal(await fresh.execute('fetch_url', {}), '网址为空。')
  assert.equal(await fresh.execute('unknown', {}), '未知工具。')

  const incomplete = executor()
  assert.match(await incomplete.execute('complete', {}), /计划还不完整/)
  assert.match(await incomplete.execute('ask_user', {}), /必须说明具体问题/)
  assert.match(await incomplete.execute('ask_user', {
    question: '要继续测试吗？', reason: '我可以自行继续',
  }), /不是必须由用户处理的阻塞/)
  assert.match(await incomplete.execute('ask_user', {
    question: '请重新登录 GitHub', reason: '当前账号缺少权限',
  }), /需要用户处理/)
  assert.equal(incomplete.progress.snapshot(false).waitingForUser, true)

  const privateRepo = executor({ repoIsPrivate: true })
  assert.match(await privateRepo.execute('search', { query: 'secret code' }), /安全策略已阻断/)
  assert.match(await privateRepo.execute('fetch_url', { url: 'https://example.com' }), /安全策略已阻断/)
})

test('remote repository tools bind plans to fetched GitHub content', { concurrency: false }, async t => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  const contents: Record<string, string> = {
    'src/app.ts': 'const marker = "old"\n',
    'duplicate.txt': 'same same\n',
  }
  globalThis.fetch = async input => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/git/trees/main')) {
      return Response.json({
        tree: [
          { type: 'blob', path: 'src/app.ts' },
          { type: 'tree', path: 'src' },
        ],
        truncated: false,
      })
    }
    const marker = '/contents/'
    const index = url.pathname.indexOf(marker)
    if (index >= 0) {
      const path = decodeURIComponent(url.pathname.slice(index + marker.length))
      const content = contents[path]
      if (content === undefined) return Response.json({}, { status: 404 })
      return Response.json({
        content: Buffer.from(content).toString('base64'),
        sha: `sha-${path}`,
        size: Buffer.byteLength(content),
      })
    }
    return Response.json({}, { status: 404 })
  }

  const { events, execute } = executor({ repo: 'owner/repo', defaultBranch: 'main' })
  assert.match(await execute('list_files', {}), /src\/app\.ts/)
  assert.match(await execute('read_file', { path: 'src/app.ts' }), /marker = "old"/)
  assert.match(await execute('read_file', { path: 'missing.ts' }), /文件不存在/)
  assert.match(await execute('write_files', {
    files: [{ path: 'src/app.ts', content: 'const marker = "new"\n' }],
  }), /等待用户确认/)
  assert.match(await execute('edit_file', {
    path: 'src/app.ts', old_string: '"old"', new_string: '"new"',
  }), /替换 1 处/)
  assert.match(await execute('edit_file', {
    path: 'src/app.ts', old_string: 'missing', new_string: 'new',
  }), /找不到指定字符串/)
  assert.match(await execute('edit_file', {
    path: 'duplicate.txt', old_string: 'same', new_string: 'new',
  }), /找到多处匹配/)

  const writePlans = events.flatMap(event => (
    'plan' in event && event.plan.kind === 'write_file' ? [event.plan] : []
  ))
  assert.equal(writePlans.length, 2)
  assert.equal(writePlans[0]?.oldContent, contents['src/app.ts'])
  assert.equal(writePlans[1]?.newContent, 'const marker = "new"\n')
})

test('workspace tools perform real git-backed mutations and enforce file risk gates', async t => {
  const current = temporaryWorkspace(t)
  const { events, execute, progress } = workspaceExecutor(current)

  assert.match(await execute('list_files', {}), /src\/app\.ts/)
  assert.match(await execute('search_files', { query: 'NEEDLE' }), /src\/app\.ts:1/)
  assert.match(await execute('search_files', { query: 'absent', path: 'src' }), /没有找到/)
  assert.match(await execute('read_file', { path: 'src/app.ts' }), /marker = "needle"/)
  assert.match(await execute('read_file', { path: 'missing.ts' }), /文件不存在/)

  assert.match(await execute('write_files', {
    files: [{ path: 'src/new.ts', content: 'export const added = true\n' }],
  }), /新建/)
  assert.equal(readFileSync(`${current.root}/src/new.ts`, 'utf8'), 'export const added = true\n')
  assert.match(await execute('edit_file', {
    path: 'src/app.ts', old_string: '"needle"', new_string: '"changed"',
  }), /替换 1 处/)
  assert.match(readFileSync(`${current.root}/src/app.ts`, 'utf8'), /"changed"/)
  assert.match(await execute('delete_files', { paths: ['delete.txt'] }), /删除 delete\.txt/)
  assert.equal(existsSync(`${current.root}/delete.txt`), false)

  writeFileSync(`${current.root}/patch.txt`, 'after\n')
  const patch = execFileSync('git', ['diff', '--no-color', '--', 'patch.txt'], {
    cwd: current.root,
    encoding: 'utf8',
  })
  writeFileSync(`${current.root}/patch.txt`, 'before\n')
  assert.match(await execute('apply_patch', { patch, dryRun: true }), /Dry-run 通过/)
  assert.equal(readFileSync(`${current.root}/patch.txt`, 'utf8'), 'before\n')
  assert.match(await execute('apply_patch', { patch, dryRun: false }), /Patch 已应用/)
  assert.equal(readFileSync(`${current.root}/patch.txt`, 'utf8'), 'after\n')

  assert.match(await execute('write_files', {
    files: [{ path: '.env', content: 'SECRET=value\n' }],
  }), /安全策略已阻断/)
  assert.equal(existsSync(`${current.root}/.env`), false)
  assert.match(await execute('write_files', {
    files: [{ path: '.github/workflows/release.yml', content: 'name: release\n' }],
  }), /高风险写入未执行/)
  assert.equal(existsSync(`${current.root}/.github/workflows/release.yml`), false)
  assert.match(await execute('edit_file', {
    path: 'payment.ts', old_string: 'old', new_string: 'new',
  }), /高风险编辑未执行/)
  assert.match(await execute('delete_files', { paths: ['auth/session.ts'] }), /高风险删除未执行/)

  mkdirSync(`${current.root}/.github/workflows`, { recursive: true })
  writeFileSync(`${current.root}/.github/workflows/ci.yml`, 'name: CI\n')
  execFileSync('git', ['add', '-N', '.github/workflows/ci.yml'], { cwd: current.root })
  const workflowPatch = execFileSync(
    'git', ['diff', '--no-color', '--', '.github/workflows/ci.yml'],
    { cwd: current.root, encoding: 'utf8' },
  )
  execFileSync('git', ['reset', '-q', '--', '.github/workflows/ci.yml'], { cwd: current.root })
  rmSync(`${current.root}/.github`, { recursive: true, force: true })
  assert.match(await execute('apply_patch', { patch: workflowPatch }), /高风险 Patch 未执行/)
  assert.equal(existsSync(`${current.root}/.github/workflows/ci.yml`), false)

  const diff = await execute('git_diff', {})
  assert.match(diff, /src\/app\.ts/)
  assert.match(diff, /patch\.txt/)
  assert.notEqual(progress.toolState.getVerifiedDiff(), null)
  assert.match(await execute('publish', {}), /任务数据库暂时不可用/)
  assert.match(await execute('complete', {}), /未发布改动/)
  assert.match(await execute('verify', {}), /未启用项目验证/)

  execFileSync('git', ['add', '-A'], { cwd: current.root })
  execFileSync('git', ['commit', '-qm', 'test mutations'], { cwd: current.root })
  assert.equal(getWorkspaceDiff(current.taskId, current.userId), '')
  assert.match(await execute('complete', {}), /任务数据库暂时不可用/)
  assert.match(await execute('check_deployment', {}), /任务数据库暂时不可用/)
  assert.ok(events.some(event => 'step' in event && event.step.kind === 'edit'))
})
