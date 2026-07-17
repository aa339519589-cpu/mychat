import { runInWorkspace } from '@/lib/agent/shell'
import { getTaskDetail } from '@/lib/agent/data'
import { getChangedFiles, getWorkspaceDiff } from '@/lib/agent/workspace'
import { runVerification } from '@/lib/agent/verify'
import { redactSensitive } from '@/lib/agent/path-security'
import { isCodeUserBlocker } from '@/lib/agent/continuation'
import { mergeTaskMeta } from '@/lib/agent/meta'
import { waitForPages } from '@/lib/github'
import { readPage } from '@/lib/tools/fetch-url'
import { commandOutput } from './format'
import { rememberCodeMemory } from './memory'
import { searchExternalCodeContext } from './search'
import type { CodeToolContext, ToolHandlers, ToolParams } from './executor-types'

const VERIFICATION_STEPS = ['lint', 'typecheck', 'test', 'build'] as const
type VerificationStep = typeof VERIFICATION_STEPS[number]

function isVerificationStep(value: unknown): value is VerificationStep {
  return typeof value === 'string'
    && (VERIFICATION_STEPS as readonly string[]).includes(value)
}

function createRepository(context: CodeToolContext, params: ToolParams): string {
  const name = String(params.name ?? '').trim()
  if (!name) return '缺少仓库名。'
  context.emit({ step: { kind: 'repo', label: `新建仓库 ${name}` } })
  context.emit({
    plan: {
      kind: 'create_repo',
      name,
      description: String(params.description ?? ''),
      private: Boolean(params.private),
    },
  })
  context.state.markPlannedRepo()
  return `已加入计划：新建仓库 ${context.login}/${name}。继续写入文件。`
}

function enablePages(context: CodeToolContext): string {
  context.emit({ step: { kind: 'deploy', label: '开启 GitHub Pages 上线' } })
  context.emit({ plan: { kind: 'enable_pages' } })
  return '已加入计划：开启 GitHub Pages。'
}

async function executeCommand(context: CodeToolContext, params: ToolParams): Promise<string> {
  const command = String(params.command ?? '').trim()
  if (!command) return '缺少 command。'
  if (!context.canExecute) return '当前运行环境未启用命令执行。'
  context.emit({ step: { kind: 'read', label: `执行：${command.slice(0, 60)}` } })
  if (!context.wsReady || !context.supabase) return '命令执行需要已就绪的隔离 workspace。'
  const remaining = context.sandboxTimeoutMs?.()
  const result = await runInWorkspace(
    context.supabase,
    context.wsUserId,
    context.wsTaskId,
    command,
    {
      repoIsPrivate: context.repoIsPrivate,
      ...(remaining == null ? {} : { timeoutMs: Math.max(1, remaining) }),
    },
  )
  return commandOutput(result)
}

async function verifyWorkspace(context: CodeToolContext, params: ToolParams): Promise<string> {
  if (!context.canExecute) return '当前运行环境未启用项目验证。'
  if (!context.wsReady || !context.supabase) return 'verify 需要 workspace。'
  const requested = Array.isArray(params.steps)
    ? params.steps.filter(isVerificationStep)
    : undefined
  context.emit({ step: { kind: 'read', label: '自动验证项目' } })
  const remaining = context.sandboxTimeoutMs?.()
  const result = await runVerification(context.wsTaskId, context.wsUserId, context.supabase, {
    repoIsPrivate: context.repoIsPrivate,
    install: params.install !== false,
    steps: requested?.length ? requested : undefined,
    ...(remaining == null ? {} : { totalTimeoutMs: Math.max(1, remaining) }),
  })
  context.state.setVerifiedDiff(result.ok
    ? getWorkspaceDiff(context.wsTaskId, context.wsUserId)
    : null)
  const steps = result.steps.map(step => (
    `${step.name}: ${step.skipped ? '跳过' : step.passed ? '通过' : '失败'}`
  )).join('\n')
  const failed = result.steps.find(step => !step.passed)
  const detail = failed ? redactSensitive(failed.stderr || failed.stdout).slice(0, 6000) : ''
  return `${result.summary}\n${steps}${detail ? `\n\n失败详情：\n${detail}` : ''}`
}

function remember(context: CodeToolContext, params: ToolParams): Promise<string> {
  return rememberCodeMemory({
    content: String(params.content ?? '').trim(),
    repo: context.repo,
    userId: context.userId,
    supabase: context.supabase,
    emit: context.emit,
  })
}

function pendingPublicationMessage(canExecute: boolean): string {
  return canExecute
    ? '当前改动还没有通过最新一轮自动验证。先调用 verify；失败就修复并重新验证。'
    : '当前改动还没有完成最新 diff 核对。先调用 git_diff 检查全部改动。'
}

async function publish(context: CodeToolContext, params: ToolParams): Promise<string> {
  if (!context.wsReady) return 'publish 需要 workspace。当前没有就绪的 workspace。'
  if (!context.supabase) return '任务数据库暂时不可用，不能发布。'
  const diff = getWorkspaceDiff(context.wsTaskId, context.wsUserId)
  if (context.state.getVerifiedDiff() === null || context.state.getVerifiedDiff() !== diff) {
    return pendingPublicationMessage(context.canExecute)
  }
  context.emit({ step: { kind: 'deploy', label: '准备发布' } })
  const changed = getChangedFiles(context.wsTaskId, context.wsUserId)
  const fileList = changed.ok
    ? changed.data.files.map(file => `  ${file.status} ${file.path}`).join('\n')
    : ''
  if (!fileList) return 'Workspace 还没有文件改动，不能发布。继续完成原始任务。'
  const task = await getTaskDetail(context.supabase, context.wsUserId, context.wsTaskId)
  if (!('workspace' in task)) return '无法读取任务状态，暂时不能发布。'
  const deployPages = params.deploy_pages === true
  if (!await mergeTaskMeta(context.supabase, context.wsUserId, context.wsTaskId, { deployPages })) {
    return '保存发布目标失败'
  }
  context.state.markPublishCalled()
  const pagesSteps = deployPages
    ? '\n4. 通过 Pull Request 合并到 main\n5. 开启 GitHub Pages 并等待网页可访问'
    : ''
  return `改动已就绪，等待用户确认发布。\n\n变更文件：\n${fileList}\n\n下一步：用户在底部点击「确认发布」按钮，平台后端会自动：\n1. git commit 所有改动\n2. push agent branch 到 GitHub\n3. 创建 Pull Request${pagesSteps}\n\n不会直接推送到 main 分支。`
}

async function complete(context: CodeToolContext): Promise<string> {
  if (context.wsReady && !context.state.hasUsedTools()) {
    return '还没有执行任何检查，不能直接宣布完成。先核对仓库或发布结果。'
  }
  if (context.wsReady && context.state.workspaceHasChanges()) {
    return 'Workspace 仍有未发布改动，不能完成。先测试并调用 publish。'
  }
  if (!context.wsReady
    && (!context.state.hasPlannedRepo() || context.state.getPlannedFiles() === 0)) {
    return '新项目计划还不完整，不能完成。'
  }
  if (context.wsReady) {
    if (!context.supabase) return '任务数据库暂时不可用，不能确认完成。'
    const task = await getTaskDetail(context.supabase, context.wsUserId, context.wsTaskId)
    if ('workspace' in task
      && task.meta?.deployPages === true
      && task.meta?.deploymentStatus !== 'ready') {
      return '网页还没有确认可访问，不能完成。继续调用 check_deployment；如果构建失败，主动排查并修复。'
    }
  }
  context.state.markCompleted()
  return '任务已明确标记为完成。请给出最终结果，不要再提出未完成事项。'
}

async function checkDeployment(context: CodeToolContext): Promise<string> {
  if (!context.wsReady || !context.repo) return '当前没有可检查的网页部署。'
  if (!context.supabase) return '任务数据库暂时不可用，不能检查部署。'
  context.emit({ step: { kind: 'deploy', label: '检查网页部署' } })
  const task = await getTaskDetail(context.supabase, context.wsUserId, context.wsTaskId)
  const expectedCommitSha = 'workspace' in task && typeof task.meta?.mergeCommitSha === 'string'
    ? task.meta.mergeCommitSha
    : undefined
  const pages = await waitForPages(context.token, context.repo, {
    verifyUrl: !context.repoIsPrivate,
    expectedCommitSha,
  })
  if ('workspace' in task) {
    await mergeTaskMeta(context.supabase, context.wsUserId, context.wsTaskId, {
      deploymentStatus: pages.status,
      pagesUrl: pages.url,
      deploymentError: pages.status === 'failed' ? pages.error : null,
    })
  }
  if (pages.status === 'ready') return `网页已经构建完成并可访问：${pages.url}`
  if (pages.status === 'failed') return `网页部署失败：${pages.error}。请主动排查原因并修复。`
  return `网页仍在部署：${pages.url}。任务尚未完成，请继续检查。`
}

function askUser(context: CodeToolContext, params: ToolParams): string {
  const question = String(params.question ?? '').trim()
  const reason = String(params.reason ?? '').trim()
  if (!question || !reason) return '必须说明具体问题和无法自行继续的原因。'
  if (!isCodeUserBlocker(question, reason)) {
    return '这不是必须由用户处理的阻塞。安装、构建、测试、验证、修复、重试和继续执行都由你自主完成；立即继续调用工具。'
  }
  context.state.markWaitingForUser()
  return `需要用户处理：${question}\n原因：${reason}`
}

function search(context: CodeToolContext, params: ToolParams): Promise<string> {
  return searchExternalCodeContext({
    query: String(params.query ?? '').trim(),
    apiKey: context.tavilyApiKey,
    signal: context.signal,
    emit: context.emit,
  })
}

function fetchUrl(context: CodeToolContext, params: ToolParams): Promise<string> | string {
  const url = String(params.url ?? '').trim()
  if (!url) return '网址为空。'
  context.emit({ step: { kind: 'read', label: `读取网页：${url.slice(0, 60)}` } })
  return readPage(url, context.signal)
}

export function createWorkflowToolHandlers(context: CodeToolContext): ToolHandlers {
  return {
    create_repo: params => createRepository(context, params),
    enable_pages: () => enablePages(context),
    execute: params => executeCommand(context, params),
    verify: params => verifyWorkspace(context, params),
    code_remember: params => remember(context, params),
    publish: params => publish(context, params),
    complete: () => complete(context),
    check_deployment: () => checkDeployment(context),
    ask_user: params => askUser(context, params),
    search: params => search(context, params),
    fetch_url: params => fetchUrl(context, params),
  }
}
