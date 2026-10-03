import type { CodePlan, Emit, MemoryEvent } from "@/lib/llm/events"
import type { SupabaseClient } from '@/lib/supabase/types'
import { memoryTools } from '@/lib/tools/memory'

export type ToolStepKind = 'list' | 'read' | 'edit' | 'memory' | 'repo' | 'deploy'

export type ToolEvent =
  | { step: { kind: ToolStepKind; label: string } }
  | { plan: CodePlan }
  | { memory: MemoryEvent }

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
  memoryEnabled?: boolean
  sensitiveMemoryEnabled?: boolean
  sandboxTimeoutMs?: () => number | null
}
type FunctionTool = {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

type CodeToolOptions = {
  isWorkspace: boolean
  executePermission: string
  canExecute: boolean
  allowExternalNetwork?: boolean
  memoryEnabled?: boolean
}

function functionTool(name: string, description: string, parameters: Record<string, unknown> = {}): FunctionTool {
  return { type: 'function', function: { name, description, parameters: { type: 'object', ...parameters } } }
}

function fileAccessTools(isWorkspace: boolean): FunctionTool[] {
  return [
    functionTool('list_files', isWorkspace ? '列出 workspace 中的文件列表。' : '列出当前仓库完整文件路径列表。'),
    ...(isWorkspace ? [functionTool('search_files', '在 workspace 全文搜索代码，返回真实文件路径和行号。定位实现、引用或错误来源时优先使用。', {
      properties: {
        query: { type: 'string', description: '要搜索的原文' },
        path: { type: 'string', description: '可选，限制在某个子目录' },
        case_sensitive: { type: 'boolean', description: '是否区分大小写，默认 false' },
      },
      required: ['query'],
    })] : []),
    functionTool('read_file', isWorkspace ? '读取 workspace 中文件的完整内容。修改前必须先读。' : '读取当前仓库某文件的真实完整内容。修改前必须先读。', {
      properties: { path: { type: 'string' } }, required: ['path'],
    }),
  ]
}

function fileMutationTools(isWorkspace: boolean): FunctionTool[] {
  return [
    functionTool('create_repo', '新建一个 GitHub 仓库（做新项目时用）。', {
      properties: {
        name: { type: 'string', description: '英文小写连字符，如 pomodoro-timer' },
        description: { type: 'string' },
        private: { type: 'boolean', description: '是否私有，默认 false' },
      }, required: ['name'],
    }),
    functionTool('enable_pages', '对纯静态/前端项目开启 GitHub Pages，让项目有可访问网址（上线）。'),
    functionTool('write_files', isWorkspace ? '直接在 workspace 中写入真实文件（会自动 snapshot 备份）。传完整文件内容。' : '生成改动计划，用户确认后执行。传完整文件内容。', {
      properties: { files: { type: 'array', items: { type: 'object', properties: {
        path: { type: 'string' }, content: { type: 'string', description: '完整文件内容' },
      }, required: ['path', 'content'] } } }, required: ['files'],
    }),
    functionTool('edit_file', isWorkspace ? '直接在 workspace 中精确修改文件（会自动 snapshot 备份）。传 old_string 和 new_string。' : '生成改动计划，用户确认后执行。用 old_string 定位原文，替换成 new_string。', {
      properties: {
        path: { type: 'string', description: '文件路径' },
        old_string: { type: 'string', description: '原文片段（必须唯一）' },
        new_string: { type: 'string', description: '替换内容' },
      }, required: ['path', 'old_string', 'new_string'],
    }),
    functionTool('delete_files', isWorkspace ? '直接从 workspace 中删除真实文件（会自动 snapshot 备份）。' : '生成删除计划，用户确认后执行。', {
      properties: { paths: { type: 'array', items: { type: 'string' } } }, required: ['paths'],
    }),
    functionTool('apply_patch', isWorkspace ? '直接在 workspace 中应用 unified diff patch 批量修改代码（推荐！）。先传 dryRun: true 预览；确认后传 dryRun: false 执行。' : '应用 unified diff patch 批量修改代码。仅在 workspace 模式下可用。', {
      properties: {
        patch: { type: 'string', description: 'unified diff 格式的 patch 内容' },
        dryRun: { type: 'boolean', description: '是否仅预览（dry-run），默认 false' },
      }, required: ['patch'],
    }),
  ]
}

function accountMemoryTools(enabled: boolean): FunctionTool[] {
  if (!enabled) return []
  return memoryTools.filter(tool => tool.enabled({
    loggedIn: true, searchMode: 'off', memoryEnabled: true, projectId: null,
  })).map(tool => functionTool(tool.name, tool.description, tool.schema))
}

function executionTools(options: CodeToolOptions): FunctionTool[] {
  if (!options.canExecute) return []
  return [functionTool('execute', `${options.executePermission}。改完代码后使用 verify 完整校验。`, {
    properties: { command: { type: 'string', description: '要执行的命令' } }, required: ['command'],
  })]
}

function networkTools(): FunctionTool[] {
  return [
    functionTool('search', '网络搜索（文档、API、技术资料等）。需要查阅外部资源时用。', {
      properties: { query: { type: 'string', description: '搜索关键词或短语' } }, required: ['query'],
    }),
    functionTool('fetch_url', '打开指定公开网址并读取正文。用于深入阅读搜索结果、文档或检查公开页面内容。', {
      properties: { url: { type: 'string', description: '完整的 http 或 https 网址' } }, required: ['url'],
    }),
  ]
}

function workspaceTools(options: CodeToolOptions): FunctionTool[] {
  if (!options.isWorkspace) return []
  const tools = [functionTool('git_diff', '查看 workspace 当前完整 git diff 和变更文件。修改后、发布前必须用它核对真实改动。')]
  if (options.canExecute) {
    tools.push(functionTool('verify', '自动识别项目并运行可用的 lint、类型检查、测试和构建。默认在需要时安装依赖；发布前必须验证通过。', {
      properties: { install: { type: 'boolean', description: '缺少依赖时是否自动安装，默认 true' }, steps: {
        type: 'array', items: { type: 'string', enum: ['lint', 'typecheck', 'test', 'build'] },
        description: '可选，只运行指定检查；默认运行全部可用检查',
      } },
    }))
  }
  tools.push(
    functionTool('publish', '文件改动和测试完成后请求用户确认发布。普通代码任务创建 PR；用户要求网页上线时 deploy_pages 必须为 true，确认后平台会通过 PR 合并并完成 Pages 部署。绝不直推 main。', {
      properties: { deploy_pages: { type: 'boolean', description: '用户要求网页上线或提供可访问网址时必须为 true' } },
      required: ['deploy_pages'],
    }),
    functionTool('check_deployment', '检查 GitHub Pages 是否构建完成并且网页确实可以访问。部署未完成时继续检查，不要让用户代替你检查。'),
  )
  return tools
}

function fixedTools(): FunctionTool[] {
  return [
    functionTool('code_remember', '记住一条关于本仓库的长期事实。', {
      properties: { content: { type: 'string' } }, required: ['content'],
    }),
    functionTool('complete', '只有整个任务已经完成并验证后才能调用。仍有文件改动、待确认发布或待部署时禁止调用。'),
    functionTool('ask_user', '只有缺少权限、缺少必要信息或必须由用户做决定时才能调用。普通技术问题必须自己解决。', {
      properties: {
        question: { type: 'string', description: '只问一个用户能直接回答的问题' },
        reason: { type: 'string', description: '说明为什么 Agent 无法自行继续' },
      }, required: ['question', 'reason'],
    }),
  ]
}

function unavailableToolNames(options: CodeToolOptions): Set<string> {
  const unavailable = new Set(options.isWorkspace ? ['create_repo', 'enable_pages'] : ['apply_patch', 'publish'])
  if (options.allowExternalNetwork === false) {
    unavailable.add('search')
    unavailable.add('fetch_url')
  }
  return unavailable
}

export function buildCodeTools(options: CodeToolOptions): FunctionTool[] {
  const tools = [
    ...fileAccessTools(options.isWorkspace),
    ...fileMutationTools(options.isWorkspace),
    ...executionTools(options),
    ...workspaceTools(options),
    ...accountMemoryTools(options.memoryEnabled === true),
    ...networkTools(),
    ...fixedTools(),
  ]
  const unavailable = unavailableToolNames(options)
  return tools.filter(tool => !unavailable.has(tool.function.name))
}
