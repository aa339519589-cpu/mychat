import { listTree, readFile as readGithubFile } from '@/lib/github'
import {
  deleteWorkspaceFile,
  editWorkspaceFile,
  getChangedFiles,
  getWorkspaceDiff,
  readWorkspaceFile,
  searchWorkspaceFiles,
  writeWorkspaceFile,
} from '@/lib/agent/workspace'
import { applyWorkspacePatch, dryRunWorkspacePatch } from '@/lib/agent/patch'
import { redactSensitive } from '@/lib/agent/path-security'
import { classifyFileRisk } from '@/lib/agent/risk'
import { isRecord } from '@/lib/unknown-value'
import type { CodeToolContext, ToolHandlers, ToolParams } from './executor-types'

async function listFiles(context: CodeToolContext): Promise<string> {
  if (context.wsReady) {
    context.emit({ step: { kind: 'list', label: '浏览 workspace 文件' } })
    const { listWorkspaceFiles } = await import('@/lib/agent/workspace')
    const result = listWorkspaceFiles(context.wsTaskId, context.wsUserId)
    if (!result.ok) return `列出文件失败：${result.error}`
    return `Workspace 共 ${result.data.total} 个文件${result.data.truncated ? '（已截断）' : ''}：\n${result.data.files.join('\n')}`
  }
  if (!context.repo || !context.defaultBranch) return '尚未选择仓库。'
  context.emit({ step: { kind: 'list', label: '浏览仓库文件结构' } })
  const { paths, truncated } = await listTree(context.token, context.repo, context.defaultBranch)
  if (!paths.length) return '仓库为空或无法获取文件列表。'
  return `仓库共 ${paths.length} 个文件${truncated ? '（已截断）' : ''}：\n${paths.join('\n')}`
}

function searchFiles(context: CodeToolContext, params: ToolParams): string {
  if (!context.wsReady) return 'search_files 需要 workspace。'
  const query = String(params.query ?? '').trim()
  if (!query) return '缺少 query。'
  context.emit({ step: { kind: 'read', label: `搜索代码：${query.slice(0, 50)}` } })
  const result = searchWorkspaceFiles(context.wsTaskId, context.wsUserId, query, {
    path: typeof params.path === 'string' ? params.path : undefined,
    caseSensitive: params.case_sensitive === true,
  })
  if (!result.ok) return `搜索失败：${result.error}`
  if (!result.data.matches.length) {
    return `已搜索 ${result.data.searchedFiles} 个文件，没有找到“${query}”。`
  }
  return `找到 ${result.data.matches.length} 处匹配${result.data.truncated ? '（结果已截断）' : ''}：\n${result.data.matches.join('\n')}`
}

async function readFile(context: CodeToolContext, params: ToolParams): Promise<string> {
  const path = String(params.path ?? '').trim()
  if (!path) return '缺少 path。'
  context.emit({ step: { kind: 'read', label: `读取 ${path}` } })
  if (context.wsReady) {
    const result = readWorkspaceFile(context.wsTaskId, context.wsUserId, path)
    return result.ok
      ? `文件 ${path} 内容：\n\`\`\`\n${result.data.content}\n\`\`\``
      : `读取失败：${result.error}`
  }
  if (!context.repo) return '尚未选择仓库。'
  const result = await readGithubFile(context.token, context.repo, path)
  return 'error' in result
    ? `读取失败：${result.error}`
    : `文件 ${path} 内容：\n\`\`\`\n${result.content}\n\`\`\``
}

function fileInputs(params: ToolParams): unknown[] {
  return Array.isArray(params.files) ? params.files : []
}

function inputPaths(files: unknown[]): string[] {
  return files.flatMap(file => {
    const item = isRecord(file) ? file : {}
    return typeof item.path === 'string' && item.path.trim() ? [item.path.trim()] : []
  })
}

async function writeWorkspaceFiles(context: CodeToolContext, files: unknown[]): Promise<string> {
  const risk = classifyFileRisk(inputPaths(files))
  if (risk.blocked) return `安全策略已阻断写入：${risk.reason}`
  if (risk.needsConfirmation) {
    context.state.markWaitingForUser()
    return `高风险写入未执行：${risk.reason}。该操作只能由客户端通过数据库单次确认门提交。`
  }
  const results: string[] = []
  for (const file of files) {
    const item = isRecord(file) ? file : {}
    const path = String(item.path ?? '').trim()
    if (!path) continue
    context.emit({ step: { kind: 'edit', label: `写入 ${path}` } })
    const result = await writeWorkspaceFile(
      context.wsTaskId, context.wsUserId, path, String(item.content ?? ''), context.supabase ?? undefined,
    )
    results.push(result.ok
      ? `✅ ${path}（${result.data.created ? '新建' : '覆盖'}）\n${result.data.diff.slice(0, 500)}`
      : `❌ ${path}：${result.error}`)
  }
  const changed = getChangedFiles(context.wsTaskId, context.wsUserId)
  const changedList = changed.ok
    ? changed.data.files.map(file => `  ${file.status} ${file.path}`).join('\n')
    : ''
  return `已在 workspace 写入 ${files.length} 个文件：\n${results.join('\n')}\n\n变更文件：\n${changedList || '（无变更）'}`
}

async function planRemoteWrites(context: CodeToolContext, files: unknown[]): Promise<string> {
  for (const file of files) {
    const item = isRecord(file) ? file : {}
    const path = String(item.path ?? '').trim()
    if (!path) continue
    let oldContent = ''
    if (context.repo) {
      const result = await readGithubFile(context.token, context.repo, path)
      if (!('error' in result)) oldContent = result.content
    }
    context.emit({ step: { kind: 'edit', label: `写入 ${path}` } })
    context.emit({ plan: { kind: 'write_file', path, oldContent, newContent: String(item.content ?? '') } })
    context.state.addPlannedFiles()
  }
  return `已加入计划：写入 ${files.length} 个文件（等待用户确认/自动执行）。`
}

async function writeFiles(context: CodeToolContext, params: ToolParams): Promise<string> {
  const files = fileInputs(params)
  if (!files.length) return '没有要写的文件。'
  return context.wsReady
    ? writeWorkspaceFiles(context, files)
    : planRemoteWrites(context, files)
}

async function editWorkspace(context: CodeToolContext, path: string, oldString: string, newString: string) {
  const risk = classifyFileRisk([path])
  if (risk.blocked) return `安全策略已阻断编辑：${risk.reason}`
  if (risk.needsConfirmation) {
    context.state.markWaitingForUser()
    return `高风险编辑未执行：${risk.reason}。该操作只能由客户端通过数据库单次确认门提交。`
  }
  const result = await editWorkspaceFile(
    context.wsTaskId, context.wsUserId, path, oldString, newString, context.supabase ?? undefined,
  )
  return result.ok
    ? `✅ 已在 workspace 编辑 ${path}（替换 1 处）\n${result.data.diff.slice(0, 500)}`
    : `编辑失败：${result.error}`
}

async function planRemoteEdit(context: CodeToolContext, path: string, oldString: string, newString: string) {
  if (!context.repo) return '尚未选择仓库。'
  const result = await readGithubFile(context.token, context.repo, path)
  if ('error' in result) return `读取失败：${result.error}`
  const index = result.content.indexOf(oldString)
  if (index === -1) return `在 ${path} 中找不到指定字符串（区分大小写）。请用 read_file 确认准确内容后重试。`
  if (result.content.indexOf(oldString, index + 1) !== -1) {
    return `在 ${path} 中找到多处匹配，请提供更精确的上下文。`
  }
  const newContent = result.content.slice(0, index)
    + newString
    + result.content.slice(index + oldString.length)
  context.emit({ plan: { kind: 'write_file', path, oldContent: result.content, newContent } })
  return `已加入计划：编辑 ${path}（替换 1 处内容）。`
}

async function editFile(context: CodeToolContext, params: ToolParams): Promise<string> {
  const path = String(params.path ?? '').trim()
  const oldString = String(params.old_string ?? '')
  const newString = String(params.new_string ?? '')
  if (!path || !oldString) return '缺少 path 或 old_string。'
  context.emit({ step: { kind: 'edit', label: `编辑 ${path}` } })
  return context.wsReady
    ? editWorkspace(context, path, oldString, newString)
    : planRemoteEdit(context, path, oldString, newString)
}

async function deleteWorkspaceFiles(context: CodeToolContext, paths: unknown[]): Promise<string> {
  const normalized = paths.map(item => String(item ?? '').trim()).filter(Boolean)
  const risk = classifyFileRisk(normalized)
  if (risk.blocked) return `安全策略已阻断删除：${risk.reason}`
  if (risk.needsConfirmation) {
    context.state.markWaitingForUser()
    return `高风险删除未执行：${risk.reason}。该操作只能由客户端通过数据库单次确认门提交。`
  }
  const results: string[] = []
  for (const path of normalized) {
    context.emit({ step: { kind: 'edit', label: `删除 ${path}` } })
    const result = await deleteWorkspaceFile(
      context.wsTaskId, context.wsUserId, path, context.supabase ?? undefined,
    )
    results.push(result.ok ? `✅ 删除 ${path}` : `❌ ${path}：${result.error}`)
  }
  return `已在 workspace 删除文件：\n${results.join('\n')}`
}

function planRemoteDeletes(context: CodeToolContext, paths: unknown[]): string {
  for (const item of paths) {
    const path = String(item ?? '').trim()
    if (!path) continue
    context.emit({ step: { kind: 'edit', label: `删除 ${path}` } })
    context.emit({ plan: { kind: 'delete_file', path } })
  }
  return `已加入计划：删除 ${paths.length} 个文件。`
}

function deleteFiles(context: CodeToolContext, params: ToolParams): string | Promise<string> {
  const paths = Array.isArray(params.paths) ? params.paths : []
  return context.wsReady
    ? deleteWorkspaceFiles(context, paths)
    : planRemoteDeletes(context, paths)
}

function patchPreview(context: CodeToolContext, patch: string): string {
  const result = dryRunWorkspacePatch(context.wsTaskId, context.wsUserId, patch)
  return result.ok
    ? `✅ Dry-run 通过：${result.changedFiles.length} 个文件将被修改\n${result.diffSummary.slice(0, 2000)}`
    : `❌ Dry-run 失败：${result.error}`
}

async function applyPatch(context: CodeToolContext, patch: string): Promise<string> {
  const preview = dryRunWorkspacePatch(context.wsTaskId, context.wsUserId, patch)
  if (!preview.ok) return `❌ Dry-run 失败：${preview.error}`
  const risk = classifyFileRisk(preview.changedFiles)
  if (risk.blocked) return `安全策略已阻断 Patch：${risk.reason}`
  if (risk.needsConfirmation) {
    context.state.markWaitingForUser()
    return `高风险 Patch 未执行：${risk.reason}。该操作只能由客户端通过数据库单次确认门提交。`
  }
  const result = await applyWorkspacePatch(context.wsTaskId, context.wsUserId, patch, {
    supabase: context.supabase ?? undefined,
  })
  if (!result.ok) return `❌ Apply patch 失败：${result.error}`
  const changed = getChangedFiles(context.wsTaskId, context.wsUserId)
  const files = changed.ok
    ? changed.data.files.map(file => `  ${file.status} ${file.path}`).join('\n')
    : ''
  return `✅ Patch 已应用：${result.changedFiles.length} 个文件\n${files}\n\n${result.diffSummary.slice(0, 2000)}`
}

function applyPatchTool(context: CodeToolContext, params: ToolParams): string | Promise<string> {
  const patch = typeof params.patch === 'string' ? params.patch : ''
  if (!patch.trim()) return '缺少 patch 内容。'
  if (!context.wsReady) return 'apply_patch 需要 workspace。当前没有就绪的 workspace。'
  const dryRun = params.dryRun === true
  context.emit({ step: { kind: 'edit', label: dryRun ? 'apply_patch (dry-run)' : 'apply_patch' } })
  return dryRun ? patchPreview(context, patch) : applyPatch(context, patch)
}

function gitDiff(context: CodeToolContext): string {
  if (!context.wsReady) return 'git_diff 需要 workspace。'
  context.emit({ step: { kind: 'read', label: '查看真实 git diff' } })
  const changed = getChangedFiles(context.wsTaskId, context.wsUserId)
  const files = changed.ok
    ? changed.data.files.map(file => `${file.status} ${file.path}`).join('\n')
    : ''
  const rawDiff = getWorkspaceDiff(context.wsTaskId, context.wsUserId)
  const diff = redactSensitive(rawDiff).slice(0, 30_000)
  if (!context.canExecute && diff) context.state.setVerifiedDiff(rawDiff)
  return diff ? `变更文件：\n${files}\n\n真实 diff：\n${diff}` : 'Workspace 当前没有改动。'
}

export function createFileToolHandlers(context: CodeToolContext): ToolHandlers {
  return {
    list_files: () => listFiles(context),
    search_files: params => searchFiles(context, params),
    read_file: params => readFile(context, params),
    write_files: params => writeFiles(context, params),
    edit_file: params => editFile(context, params),
    delete_files: params => deleteFiles(context, params),
    apply_patch: params => applyPatchTool(context, params),
    git_diff: () => gitDiff(context),
  }
}
