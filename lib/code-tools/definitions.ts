import type { CodePlan, Emit } from "@/lib/llm/events"
import type { SupabaseClient } from '@/lib/supabase/types'

export type ToolStepKind = 'list' | 'read' | 'edit' | 'memory' | 'repo' | 'deploy'

export type ToolEvent =
  | { step: { kind: ToolStepKind; label: string } }
  | { plan: CodePlan }

export type ToolState = {
  markUsedTool: () => void
  hasUsedTools: () => boolean
  markPlannedRepo: () => void
  hasPlannedRepo: () => boolean
  addPlannedFiles: (count?: number) => void
  getPlannedFiles: () => number
  markPublishCalled: () => void
  hasPublishCalled: () => boolean
  markCompleted: () => void
  markWaitingForUser: () => void
  getVerifiedDiff: () => string | null
  setVerifiedDiff: (diff: string | null) => void
  workspaceHasChanges: () => boolean
}

export type CodeToolExecutorOptions = {
  repo: string | null
  login: string
  token: string
  defaultBranch: string | null
  repoIsPrivate: boolean
  supabase: SupabaseClient | null
  userId: string | null
  wsReady: boolean
  wsTaskId: string
  wsUserId: string
  tavilyApiKey: string
  emit: Emit
  state: ToolState
  signal?: AbortSignal
  canExecute: boolean
  sandboxTimeoutMs?: () => number | null
}
export function buildCodeTools(options: {
  isWorkspace: boolean
  executePermission: string
  canExecute: boolean
  allowExternalNetwork?: boolean
}) {
  const { isWorkspace } = options
  const allTools = [
    { type: 'function', function: { name: 'list_files', description: isWorkspace ? '列出 workspace 中的文件列表。' : '列出当前仓库完整文件路径列表。', parameters: { type: 'object', properties: {} } } },
    ...(isWorkspace ? [{ type: 'function', function: { name: 'search_files', description: '在 workspace 全文搜索代码，返回真实文件路径和行号。定位实现、引用或错误来源时优先使用。', parameters: { type: 'object', properties: { query: { type: 'string', description: '要搜索的原文' }, path: { type: 'string', description: '可选，限制在某个子目录' }, case_sensitive: { type: 'boolean', description: '是否区分大小写，默认 false' } }, required: ['query'] } } }] : []),
    { type: 'function', function: { name: 'read_file', description: isWorkspace ? '读取 workspace 中文件的完整内容。修改前必须先读。' : '读取当前仓库某文件的真实完整内容。修改前必须先读。', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
    { type: 'function', function: { name: 'create_repo', description: '新建一个 GitHub 仓库（做新项目时用）。', parameters: { type: 'object', properties: { name: { type: 'string', description: '英文小写连字符，如 pomodoro-timer' }, description: { type: 'string' }, private: { type: 'boolean', description: '是否私有，默认 false' } }, required: ['name'] } } },
    { type: 'function', function: { name: 'write_files', description: isWorkspace ? '直接在 workspace 中写入真实文件（会自动 snapshot 备份）。传完整文件内容。' : '生成改动计划，用户确认后执行。传完整文件内容。', parameters: { type: 'object', properties: { files: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string', description: '完整文件内容' } }, required: ['path', 'content'] } } }, required: ['files'] } } },
    { type: 'function', function: { name: 'edit_file', description: isWorkspace ? '直接在 workspace 中精确修改文件（会自动 snapshot 备份）。传 old_string 和 new_string。' : '生成改动计划，用户确认后执行。用 old_string 定位原文，替换成 new_string。', parameters: { type: 'object', properties: { path: { type: 'string', description: '文件路径' }, old_string: { type: 'string', description: '原文片段（必须唯一）' }, new_string: { type: 'string', description: '替换内容' } }, required: ['path', 'old_string', 'new_string'] } } },
    { type: 'function', function: { name: 'delete_files', description: isWorkspace ? '直接从 workspace 中删除真实文件（会自动 snapshot 备份）。' : '生成删除计划，用户确认后执行。', parameters: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' } } }, required: ['paths'] } } },
    ...(options.canExecute ? [{ type: 'function', function: { name: 'execute', description: `${options.executePermission}。改完代码后使用 verify 完整校验。`, parameters: { type: 'object', properties: { command: { type: 'string', description: '要执行的命令' } }, required: ['command'] } } }] : []),
    { type: 'function', function: { name: 'enable_pages', description: '对纯静态/前端项目开启 GitHub Pages，让项目有可访问网址（上线）。', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'code_remember', description: '记住一条关于本仓库的长期事实。', parameters: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'] } } },
    { type: 'function', function: { name: 'search', description: '网络搜索（文档、API、技术资料等）。需要查阅外部资源时用。', parameters: { type: 'object', properties: { query: { type: 'string', description: '搜索关键词或短语' } }, required: ['query'] } } },
    { type: 'function', function: { name: 'fetch_url', description: '打开指定公开网址并读取正文。用于深入阅读搜索结果、文档或检查公开页面内容。', parameters: { type: 'object', properties: { url: { type: 'string', description: '完整的 http 或 https 网址' } }, required: ['url'] } } },
    { type: 'function', function: { name: 'apply_patch', description: isWorkspace ? '直接在 workspace 中应用 unified diff patch 批量修改代码（推荐！）。先传 dryRun: true 预览；确认后传 dryRun: false 执行。' : '应用 unified diff patch 批量修改代码。仅在 workspace 模式下可用。', parameters: { type: 'object', properties: { patch: { type: 'string', description: 'unified diff 格式的 patch 内容' }, dryRun: { type: 'boolean', description: '是否仅预览（dry-run），默认 false' } }, required: ['patch'] } } },
    ...(isWorkspace ? [{ type: 'function', function: { name: 'git_diff', description: '查看 workspace 当前完整 git diff 和变更文件。修改后、发布前必须用它核对真实改动。', parameters: { type: 'object', properties: {} } } }] : []),
    ...(isWorkspace && options.canExecute ? [{ type: 'function', function: { name: 'verify', description: '自动识别项目并运行可用的 lint、类型检查、测试和构建。默认在需要时安装依赖；发布前必须验证通过。', parameters: { type: 'object', properties: { install: { type: 'boolean', description: '缺少依赖时是否自动安装，默认 true' }, steps: { type: 'array', items: { type: 'string', enum: ['lint', 'typecheck', 'test', 'build'] }, description: '可选，只运行指定检查；默认运行全部可用检查' } } } } }] : []),
    ...(isWorkspace ? [{ type: 'function', function: { name: 'publish', description: '文件改动和测试完成后请求用户确认发布。普通代码任务创建 PR；用户要求网页上线时 deploy_pages 必须为 true，确认后平台会通过 PR 合并并完成 Pages 部署。绝不直推 main。', parameters: { type: 'object', properties: { deploy_pages: { type: 'boolean', description: '用户要求网页上线或提供可访问网址时必须为 true' } }, required: ['deploy_pages'] } } }] : []),
    ...(isWorkspace ? [{ type: 'function', function: { name: 'check_deployment', description: '检查 GitHub Pages 是否构建完成并且网页确实可以访问。部署未完成时继续检查，不要让用户代替你检查。', parameters: { type: 'object', properties: {} } } }] : []),
    { type: 'function', function: { name: 'complete', description: '只有整个任务已经完成并验证后才能调用。仍有文件改动、待确认发布或待部署时禁止调用。', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'ask_user', description: '只有缺少权限、缺少必要信息或必须由用户做决定时才能调用。普通技术问题必须自己解决。', parameters: { type: 'object', properties: { question: { type: 'string', description: '只问一个用户能直接回答的问题' }, reason: { type: 'string', description: '说明为什么 Agent 无法自行继续' } }, required: ['question', 'reason'] } } },
  ]

  const unavailable = new Set(isWorkspace ? ['create_repo', 'enable_pages'] : ['apply_patch', 'publish'])
  if (options.allowExternalNetwork === false) {
    unavailable.add('search')
    unavailable.add('fetch_url')
  }
  return allTools.filter(tool => !unavailable.has(tool.function.name))
}
