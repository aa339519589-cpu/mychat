import { listTree, readFile, waitForPages } from '@/lib/github'
import { runInWorkspace } from '@/lib/agent/shell'
import {
  writeWorkspaceFile, editWorkspaceFile, deleteWorkspaceFile,
  getChangedFiles, getWorkspaceDiff, readWorkspaceFile, searchWorkspaceFiles,
} from '@/lib/agent/workspace'
import { applyWorkspacePatch, dryRunWorkspacePatch } from '@/lib/agent/patch'
import { getTaskDetail } from '@/lib/agent/data'
import { runVerification } from '@/lib/agent/verify'
import { redactSensitive } from '@/lib/agent/path-security'
import { classifyFileRisk } from '@/lib/agent/risk'
import { readPage } from '@/lib/tools/fetch-url'
import { isCodeUserBlocker } from '@/lib/agent/continuation'
import { mergeTaskMeta } from '@/lib/agent/meta'
import { type CodeToolExecutorOptions, type ToolEvent } from './definitions'
import { commandOutput } from './format'
import { isRecord } from '@/lib/unknown-value'
import { rememberCodeMemory } from './memory'
import { searchExternalCodeContext } from './search'

export { buildCodeTools } from './definitions'




export function createCodeToolExecutor(options: CodeToolExecutorOptions) {
  const {
    repo, login, token, defaultBranch, repoIsPrivate, supabase, userId,
    wsReady, wsTaskId, wsUserId, tavilyApiKey, emit, state, signal, canExecute,
    sandboxTimeoutMs,
  } = options

  const toolEmit = (event: ToolEvent) => emit(event)

  return async function executeTool(name: string, input: unknown) {
    const params = isRecord(input) ? input : {}
    if (name !== 'complete') state.markUsedTool()

    if (repoIsPrivate && (name === 'search' || name === 'fetch_url')) {
      return '安全策略已阻断：私有仓库任务不能把模型生成的查询或网址发送给外部检索服务。'
    }

    if (name === 'list_files') {
      if (wsReady) {
        toolEmit({ step: { kind: 'list', label: '浏览 workspace 文件' } })
        const { listWorkspaceFiles } = await import('@/lib/agent/workspace')
        const res = listWorkspaceFiles(wsTaskId, wsUserId)
        if (res.ok) return `Workspace 共 ${res.data.total} 个文件${res.data.truncated ? '（已截断）' : ''}：\n${res.data.files.join('\n')}`
        return `列出文件失败：${res.error}`
      }
      if (!repo || !defaultBranch) return '尚未选择仓库。'
      toolEmit({ step: { kind: 'list', label: '浏览仓库文件结构' } })
      const { paths, truncated } = await listTree(token, repo, defaultBranch)
      if (!paths.length) return '仓库为空或无法获取文件列表。'
      return `仓库共 ${paths.length} 个文件${truncated ? '（已截断）' : ''}：\n${paths.join('\n')}`
    }

    if (name === 'search_files') {
      if (!wsReady) return 'search_files 需要 workspace。'
      const query = String(params.query ?? '').trim()
      if (!query) return '缺少 query。'
      toolEmit({ step: { kind: 'read', label: `搜索代码：${query.slice(0, 50)}` } })
      const result = searchWorkspaceFiles(wsTaskId, wsUserId, query, {
        path: typeof params.path === 'string' ? params.path : undefined,
        caseSensitive: params.case_sensitive === true,
      })
      if (!result.ok) return `搜索失败：${result.error}`
      if (!result.data.matches.length) return `已搜索 ${result.data.searchedFiles} 个文件，没有找到“${query}”。`
      return `找到 ${result.data.matches.length} 处匹配${result.data.truncated ? '（结果已截断）' : ''}：\n${result.data.matches.join('\n')}`
    }

    if (name === 'read_file') {
      const path = String(params.path ?? '').trim()
      if (!path) return '缺少 path。'
      toolEmit({ step: { kind: 'read', label: `读取 ${path}` } })

      if (wsReady) {
        const res = readWorkspaceFile(wsTaskId, wsUserId, path)
        if (!res.ok) return `读取失败：${res.error}`
        return `文件 ${path} 内容：\n\`\`\`\n${res.data.content}\n\`\`\``
      }

      if (!repo) return '尚未选择仓库。'
      const result = await readFile(token, repo, path)
      if ('error' in result) return `读取失败：${result.error}`
      return `文件 ${path} 内容：\n\`\`\`\n${result.content}\n\`\`\``
    }

    if (name === 'create_repo') {
      const repoName = String(params.name ?? '').trim()
      if (!repoName) return '缺少仓库名。'
      toolEmit({ step: { kind: 'repo', label: `新建仓库 ${repoName}` } })
      toolEmit({ plan: { kind: 'create_repo', name: repoName, description: String(params.description ?? ''), private: !!params.private } })
      state.markPlannedRepo()
      return `已加入计划：新建仓库 ${login}/${repoName}。继续写入文件。`
    }

    if (name === 'write_files') {
      const files = Array.isArray(params.files) ? params.files : []
      if (!files.length) return '没有要写的文件。'

      if (wsReady) {
        const paths = files.flatMap(file => {
          const item = isRecord(file) ? file : {}
          return typeof item.path === 'string' && item.path.trim() ? [item.path.trim()] : []
        })
        const risk = classifyFileRisk(paths)
        if (risk.blocked) return `安全策略已阻断写入：${risk.reason}`
        if (risk.needsConfirmation) {
          state.markWaitingForUser()
          return `高风险写入未执行：${risk.reason}。该操作只能由客户端通过数据库单次确认门提交。`
        }
        const results: string[] = []
        for (const file of files) {
          const item = isRecord(file) ? file : {}
          const path = String(item.path ?? '').trim()
          const content = String(item.content ?? '')
          if (!path) continue
          toolEmit({ step: { kind: 'edit', label: `写入 ${path}` } })
          const res = await writeWorkspaceFile(wsTaskId, wsUserId, path, content, supabase ?? undefined)
          if (res.ok) {
            results.push(`✅ ${path}（${res.data.created ? '新建' : '覆盖'}）\n${res.data.diff.slice(0, 500)}`)
          } else {
            results.push(`❌ ${path}：${res.error}`)
          }
        }
        const changed = getChangedFiles(wsTaskId, wsUserId)
        const changedList = changed.ok ? changed.data.files.map(f => `  ${f.status} ${f.path}`).join('\n') : ''
        return `已在 workspace 写入 ${files.length} 个文件：\n${results.join('\n')}\n\n变更文件：\n${changedList || '（无变更）'}`
      }

      for (const file of files) {
        const item = isRecord(file) ? file : {}
        const path = String(item.path ?? '').trim()
        const content = String(item.content ?? '')
        if (!path) continue
        let oldContent = ''
        if (repo) {
          const res = await readFile(token, repo, path)
          if (!('error' in res)) oldContent = res.content
        }
        toolEmit({ step: { kind: 'edit', label: `写入 ${path}` } })
        toolEmit({ plan: { kind: 'write_file', path, oldContent, newContent: content } })
        state.addPlannedFiles()
      }
      return `已加入计划：写入 ${files.length} 个文件（等待用户确认/自动执行）。`
    }

    if (name === 'edit_file') {
      const path = String(params.path ?? '').trim()
      const oldString = String(params.old_string ?? '')
      const newString = String(params.new_string ?? '')
      if (!path || !oldString) return '缺少 path 或 old_string。'
      toolEmit({ step: { kind: 'edit', label: `编辑 ${path}` } })

      if (wsReady) {
        const risk = classifyFileRisk([path])
        if (risk.blocked) return `安全策略已阻断编辑：${risk.reason}`
        if (risk.needsConfirmation) {
          state.markWaitingForUser()
          return `高风险编辑未执行：${risk.reason}。该操作只能由客户端通过数据库单次确认门提交。`
        }
        const res = await editWorkspaceFile(wsTaskId, wsUserId, path, oldString, newString, supabase ?? undefined)
        if (!res.ok) return `编辑失败：${res.error}`
        return `✅ 已在 workspace 编辑 ${path}（替换 1 处）\n${res.data.diff.slice(0, 500)}`
      }

      if (!repo) return '尚未选择仓库。'
      const result = await readFile(token, repo, path)
      if ('error' in result) return `读取失败：${result.error}`
      const content = result.content
      const index = content.indexOf(oldString)
      if (index === -1) return `在 ${path} 中找不到指定字符串（区分大小写）。请用 read_file 确认准确内容后重试。`
      if (content.indexOf(oldString, index + 1) !== -1) return `在 ${path} 中找到多处匹配，请提供更精确的上下文。`
      const newContent = content.slice(0, index) + newString + content.slice(index + oldString.length)
      toolEmit({ plan: { kind: 'write_file', path, oldContent: content, newContent } })
      return `已加入计划：编辑 ${path}（替换 1 处内容）。`
    }

    if (name === 'delete_files') {
      const paths = Array.isArray(params.paths) ? params.paths : []

      if (wsReady) {
        const normalizedPaths = paths.flatMap(item => {
          const path = String(item ?? '').trim()
          return path ? [path] : []
        })
        const risk = classifyFileRisk(normalizedPaths)
        if (risk.blocked) return `安全策略已阻断删除：${risk.reason}`
        if (risk.needsConfirmation) {
          state.markWaitingForUser()
          return `高风险删除未执行：${risk.reason}。该操作只能由客户端通过数据库单次确认门提交。`
        }
        const results: string[] = []
        for (const item of paths) {
          const path = String(item ?? '').trim()
          if (!path) continue
          toolEmit({ step: { kind: 'edit', label: `删除 ${path}` } })
          const res = await deleteWorkspaceFile(wsTaskId, wsUserId, path, supabase ?? undefined)
          results.push(res.ok ? `✅ 删除 ${path}` : `❌ ${path}：${res.error}`)
        }
        return `已在 workspace 删除文件：\n${results.join('\n')}`
      }

      for (const item of paths) {
        const path = String(item ?? '').trim()
        if (!path) continue
        toolEmit({ step: { kind: 'edit', label: `删除 ${path}` } })
        toolEmit({ plan: { kind: 'delete_file', path } })
      }
      return `已加入计划：删除 ${paths.length} 个文件。`
    }

    if (name === 'enable_pages') {
      toolEmit({ step: { kind: 'deploy', label: '开启 GitHub Pages 上线' } })
      toolEmit({ plan: { kind: 'enable_pages' } })
      return '已加入计划：开启 GitHub Pages。'
    }

    if (name === 'execute') {
      const command = String(params.command ?? '').trim()
      if (!command) return '缺少 command。'
      toolEmit({ step: { kind: 'read', label: `执行：${command.slice(0, 60)}` } })

      if (wsReady && supabase) {
        const remaining = sandboxTimeoutMs?.()
        const result = await runInWorkspace(supabase, wsUserId, wsTaskId, command, {
          repoIsPrivate,
          ...(remaining === null || remaining === undefined
            ? {}
            : { timeoutMs: Math.max(1, remaining) }),
        })
        return commandOutput(result)
      }

      return '命令执行需要已就绪的隔离 workspace。'
    }

    if (name === 'verify') {
      if (!wsReady || !supabase) return 'verify 需要 workspace。'
      const allowed = new Set(['lint', 'typecheck', 'test', 'build'])
      const requested = Array.isArray(params.steps)
        ? params.steps.filter((step: unknown) => typeof step === 'string' && allowed.has(step))
        : undefined
      toolEmit({ step: { kind: 'read', label: '自动验证项目' } })
      const remaining = sandboxTimeoutMs?.()
      const result = await runVerification(wsTaskId, wsUserId, supabase, {
        repoIsPrivate,
        install: params.install !== false,
        steps: requested?.length ? requested : undefined,
        ...(remaining == null ? {} : {
          totalTimeoutMs: Math.max(1, remaining),
        }),
      })
      state.setVerifiedDiff(result.ok ? getWorkspaceDiff(wsTaskId, wsUserId) : null)
      const steps = result.steps.map(step => `${step.name}: ${step.skipped ? '跳过' : step.passed ? '通过' : '失败'}`).join('\n')
      const failed = result.steps.find(step => !step.passed)
      const detail = failed ? redactSensitive(failed.stderr || failed.stdout).slice(0, 6000) : ''
      return `${result.summary}\n${steps}${detail ? `\n\n失败详情：\n${detail}` : ''}`
    }

    if (name === 'code_remember') {
      const content = String(params.content ?? '').trim()
      return rememberCodeMemory({ content, repo, userId, supabase, emit: toolEmit })
    }

    if (name === 'apply_patch') {
      const patch = typeof params.patch === 'string' ? params.patch : ''
      if (!patch.trim()) return '缺少 patch 内容。'
      const dryRun = params.dryRun === true

      if (wsReady) {
        toolEmit({ step: { kind: 'edit', label: dryRun ? 'apply_patch (dry-run)' : 'apply_patch' } })
        if (dryRun) {
          const res = dryRunWorkspacePatch(wsTaskId, wsUserId, patch)
          if (!res.ok) return `❌ Dry-run 失败：${res.error}`
          return `✅ Dry-run 通过：${res.changedFiles.length} 个文件将被修改\n${res.diffSummary.slice(0, 2000)}`
        }
        const preview = dryRunWorkspacePatch(wsTaskId, wsUserId, patch)
        if (!preview.ok) return `❌ Dry-run 失败：${preview.error}`
        const risk = classifyFileRisk(preview.changedFiles)
        if (risk.blocked) return `安全策略已阻断 Patch：${risk.reason}`
        if (risk.needsConfirmation) {
          state.markWaitingForUser()
          return `高风险 Patch 未执行：${risk.reason}。该操作只能由客户端通过数据库单次确认门提交。`
        }
        const applyRes = await applyWorkspacePatch(wsTaskId, wsUserId, patch, { supabase: supabase ?? undefined })
        if (!applyRes.ok) return `❌ Apply patch 失败：${applyRes.error}`
        const changed = getChangedFiles(wsTaskId, wsUserId)
        const files = changed.ok ? changed.data.files.map(f => `  ${f.status} ${f.path}`).join('\n') : ''
        return `✅ Patch 已应用：${applyRes.changedFiles.length} 个文件\n${files}\n\n${applyRes.diffSummary.slice(0, 2000)}`
      }

      return 'apply_patch 需要 workspace。当前没有就绪的 workspace。'
    }

    if (name === 'git_diff') {
      if (!wsReady) return 'git_diff 需要 workspace。'
      toolEmit({ step: { kind: 'read', label: '查看真实 git diff' } })
      const changed = getChangedFiles(wsTaskId, wsUserId)
      const files = changed.ok ? changed.data.files.map(file => `${file.status} ${file.path}`).join('\n') : ''
      const diff = redactSensitive(getWorkspaceDiff(wsTaskId, wsUserId)).slice(0, 30000)
      if (!canExecute && diff) state.setVerifiedDiff(getWorkspaceDiff(wsTaskId, wsUserId))
      return diff ? `变更文件：\n${files}\n\n真实 diff：\n${diff}` : 'Workspace 当前没有改动。'
    }

    if (name === 'publish') {
      if (!wsReady) return 'publish 需要 workspace。当前没有就绪的 workspace。'
      if (!supabase) return '任务数据库暂时不可用，不能发布。'
      if (state.getVerifiedDiff() === null || state.getVerifiedDiff() !== getWorkspaceDiff(wsTaskId, wsUserId)) {
        return canExecute
          ? '当前改动还没有通过最新一轮自动验证。先调用 verify；失败就修复并重新验证。'
          : '当前改动还没有完成最新 diff 核对。先调用 git_diff 检查全部改动。'
      }
      toolEmit({ step: { kind: 'deploy', label: '准备发布' } })
      const changed = getChangedFiles(wsTaskId, wsUserId)
      const fileList = changed.ok ? changed.data.files.map(f => `  ${f.status} ${f.path}`).join('\n') : ''
      if (!fileList) return 'Workspace 还没有文件改动，不能发布。继续完成原始任务。'
      const task = await getTaskDetail(supabase, wsUserId, wsTaskId)
      if (!('workspace' in task)) return '无法读取任务状态，暂时不能发布。'
      const deployPages = params.deploy_pages === true
      const updatedMeta = await mergeTaskMeta(supabase, wsUserId, wsTaskId, { deployPages })
      if (!updatedMeta) return '保存发布目标失败'
      state.markPublishCalled()
      return `改动已就绪，等待用户确认发布。\n\n变更文件：\n${fileList || '（请先修改文件）'}\n\n下一步：用户在底部点击「确认发布」按钮，平台后端会自动：\n1. git commit 所有改动\n2. push agent branch 到 GitHub\n3. 创建 Pull Request${deployPages ? '\n4. 通过 Pull Request 合并到 main\n5. 开启 GitHub Pages 并等待网页可访问' : ''}\n\n不会直接推送到 main 分支。`
    }

    if (name === 'complete') {
      if (wsReady && !state.hasUsedTools()) return '还没有执行任何检查，不能直接宣布完成。先核对仓库或发布结果。'
      if (wsReady && state.workspaceHasChanges()) return 'Workspace 仍有未发布改动，不能完成。先测试并调用 publish。'
      if (!wsReady && (!state.hasPlannedRepo() || state.getPlannedFiles() === 0)) return '新项目计划还不完整，不能完成。'
      if (wsReady) {
        if (!supabase) return '任务数据库暂时不可用，不能确认完成。'
        const task = await getTaskDetail(supabase, wsUserId, wsTaskId)
        if ('workspace' in task && task.meta?.deployPages === true && task.meta?.deploymentStatus !== 'ready') {
          return '网页还没有确认可访问，不能完成。继续调用 check_deployment；如果构建失败，主动排查并修复。'
        }
      }
      state.markCompleted()
      return '任务已明确标记为完成。请给出最终结果，不要再提出未完成事项。'
    }

    if (name === 'check_deployment') {
      if (!wsReady || !repo) return '当前没有可检查的网页部署。'
      if (!supabase) return '任务数据库暂时不可用，不能检查部署。'
      toolEmit({ step: { kind: 'deploy', label: '检查网页部署' } })
      const task = await getTaskDetail(supabase, wsUserId, wsTaskId)
      const expectedCommitSha = 'workspace' in task && typeof task.meta?.mergeCommitSha === 'string'
        ? task.meta.mergeCommitSha
        : undefined
      const pages = await waitForPages(token, repo, {
        verifyUrl: !repoIsPrivate,
        expectedCommitSha,
      })
      if ('workspace' in task) {
        await mergeTaskMeta(supabase, wsUserId, wsTaskId, {
          deploymentStatus: pages.status,
          pagesUrl: pages.url,
          deploymentError: pages.status === 'failed' ? pages.error : null,
        })
      }
      if (pages.status === 'ready') return `网页已经构建完成并可访问：${pages.url}`
      if (pages.status === 'failed') return `网页部署失败：${pages.error}。请主动排查原因并修复。`
      return `网页仍在部署：${pages.url}。任务尚未完成，请继续检查。`
    }

    if (name === 'ask_user') {
      const question = String(params.question ?? '').trim()
      const reason = String(params.reason ?? '').trim()
      if (!question || !reason) return '必须说明具体问题和无法自行继续的原因。'
      if (!isCodeUserBlocker(question, reason)) {
        return '这不是必须由用户处理的阻塞。安装、构建、测试、验证、修复、重试和继续执行都由你自主完成；立即继续调用工具。'
      }
      state.markWaitingForUser()
      return `需要用户处理：${question}\n原因：${reason}`
    }

    if (name === 'search') {
      const query = String(params.query ?? '').trim()
      return searchExternalCodeContext({ query, apiKey: tavilyApiKey, signal, emit: toolEmit })
    }

    if (name === 'fetch_url') {
      const url = String(params.url ?? '').trim()
      if (!url) return '网址为空。'
      toolEmit({ step: { kind: 'read', label: `读取网页：${url.slice(0, 60)}` } })
      return readPage(url, signal)
    }

    return '未知工具。'
  }
}
