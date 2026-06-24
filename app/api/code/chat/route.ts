import { NextRequest } from 'next/server'
import { cookies } from 'next/headers'
import { TIER_MAP } from '@/lib/chat-data'
import { send, done, networkError } from '@/lib/llm/stream'
import { toOpenAI, chatCompletionsUrl } from '@/lib/llm/openai'
import { runAgentLoop, type ExecuteTool } from '@/lib/llm/agent-loop'
import type { Emit } from '@/lib/llm/events'
import { listTree, readFile, repoMeta, waitForPages } from '@/lib/github'
import { log } from '@/lib/logger'
import { validate } from '@/lib/validation'
import { addQuotaUsage } from '@/lib/quota'
import { resolveAuth, enforceLimits } from '@/lib/api/guard'
import { runInSandbox } from '@/lib/sandbox'
import { runInWorkspace } from '@/lib/agent/shell'
import { createRecorder } from '@/lib/agent/recorder'
import { codeContinuationPrompt } from '@/lib/agent/continuation'
import {
  writeWorkspaceFile, editWorkspaceFile, deleteWorkspaceFile,
  getChangedFiles, getWorkspaceDiff, readWorkspaceFile, searchWorkspaceFiles,
  createWorkspaceForTask,
} from '@/lib/agent/workspace'
import { applyWorkspacePatch, dryRunWorkspacePatch } from '@/lib/agent/patch'
import { getTaskDetail } from '@/lib/agent/data'
import { runVerification } from '@/lib/agent/verify'
import { redactSensitive } from '@/lib/agent/path-security'
import { readPage } from '@/lib/tools/fetch-url'
import { existsSync } from 'fs'

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY ?? ''
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com'
const TAVILY_API_KEY = process.env.TAVILY_API_KEY ?? ''

function buildCodeSystem(repo: string | null, login: string, memories: string[], hasWorkspace: boolean): string {
  const wsSection = hasWorkspace ? `
🚫 你已进入 Workspace 模式。你没有直接推 main 的能力，也没有 GitHub 认证信息。
你唯一能做的发布方式：完成文件修改 → 展示 diff → 让用户点击底部「确认发布」按钮。

禁止在你的回复中出现以下任何内容：
- "直接写入 main"、"直接提交 main"、"直接推送"、"直推"、"选项 A"、"选项 B"
- "无法创建 PR"、"没有 PR API"、"没有 GitHub 认证"
- "git push"、"gh pr create"、"手动 git"、"手动创建 PR"
- 任何形式的 "你可以手动..." git 命令示例

你能使用的工具：
- write_files / edit_file / delete_files：直接修改 workspace 里的真实文件（会自动 snapshot 备份）
- apply_patch：用 unified diff 批量修改代码
- execute：在 workspace 里执行命令（node --check、npm run build、npm test 等）
- list_files / search_files / read_file：浏览、搜索并读取 workspace 文件
- git_diff：查看当前全部真实改动
- verify：自动安装依赖并运行项目可用的 lint、类型检查、测试和构建
- publish：改动完成后请求用户确认发布；网页任务必须设置 deploy_pages=true
- check_deployment：确认发布后检查网页是否已经真正可访问
- complete：只有整个任务已经完成并验证后才能调用
- ask_user：只有缺少权限或必须由用户决定时才能提问并暂停

改完代码后的标准流程：
1. 展示 diff（让用户看到你改了什么）
2. 调用 publish 工具；用户要求网页上线时设置 deploy_pages=true
3. 告诉用户："改动已完成，请点击底部确认发布。"
4. 不要提供任何其他发布方案或选项
` : `
【Plan 模式】你目前没有 workspace，改动通过 plan 模式执行：
- write_files / edit_file / delete_files：生成改动计划，展示给用户确认后执行
- execute：在沙箱中运行命令
`;

  let s = `你是「小克 · 代码」，一个能真正操作用户 GitHub 账号的编程助手，运行在网页应用的 Code 板块里。当前用户的 GitHub 用户名是 ${login}。
${wsSection}
你能使用的工具：
- list_files：列出仓库文件列表。
- read_file：读取文件完整内容。修改前必须先读。
- create_repo：新建一个 GitHub 仓库。仓库名用英文小写连字符（如 pomodoro-timer）。
- write_files：写入一个或多个文件（新建或覆盖），传完整内容。
- edit_file：精确修改文件中的一段内容。传 old_string（原文唯一片段）和 new_string。
- delete_files：删除文件。
- apply_patch：应用 unified diff patch 批量修改代码。先传 dryRun: true 预览，确认后 dryRun: false 执行。${hasWorkspace ? "这是推荐的修改方式。" : "仅在 workspace 模式下可用。"}
- execute：${hasWorkspace ? "在 workspace 中执行命令（node --check / npm test / npm run build 等）" : "在沙箱中运行命令进行校验（node --check / node -e / python3 -c 等）"}。
- enable_pages：开启 GitHub Pages 上线。
- code_remember：记住一条本仓库的长期事实。
- search：网络搜索文档、API、技术资料。
- fetch_url：读取指定网页的正文。
- search_files / git_diff / verify：搜索代码、查看真实改动、自动验证当前 workspace。
- check_deployment：检查 GitHub Pages 是否构建完成且网页可访问。
- complete：明确声明整个任务已经完成。仍有改动或待发布步骤时禁止调用。
- ask_user：遇到自己无法解决的权限或选择问题时，向用户提出一个明确问题。

工作方式（重要）：
1. 用户用大白话描述要做什么。你自行判断、定位文件、动手修改。
2. 做新项目：create_repo → write_files 写全部文件 →（纯前端）enable_pages 上线。
3. 改现有项目：先 list_files / read_file 定位，再 edit_file 或 write_files 给出改动${hasWorkspace ? "，推荐用 apply_patch 批量修改" : ""}。
4. 改完代码后调用 verify 自动验证；失败就继续修复并重新验证。
${hasWorkspace
  ? "5. 改完调用 publish 工具。网页上线任务必须设置 deploy_pages=true。确认发布后的结果会自动交还给你继续检查，全部完成后调用 complete。"
  : "5. 你的改动会生成待执行计划展示给用户，用户确认后提交并推送。"}
6. 回复【开头第一行】必须是 git 提交信息（20 字内中文，如「新增 edit_file 工具」）。
7. 做完用中文简明说明，像干练的工程师，不要 emoji。

工具调用注意：
- 必须用标准 OpenAPI function calling 格式调用工具，不要用 DSML 文本模拟。
- edit_file 的 old_string 必须与原文完全一致（区分大小写），且唯一出现。
- 不确定时先用 read_file 确认当前状态。`

  if (repo) s += `\n\n当前仓库：${repo}。`
  else s += `\n\n用户尚未选择仓库。做新项目用 create_repo 新建。`

  if (memories.length) s += `\n\n本仓库记忆（${memories.length} 条）：\n${memories.map(m => `- ${m}`).join('\n')}`
  s += `\n\n【Agent 模式】这是持续执行任务，不是一问一答。请自主连续使用工具推进，读取结果后决定下一步。除等待用户确认发布、遇到明确权限问题、或调用 complete 确认全部完成外，不得停止。不要让用户反复说“继续”。`
  return s
}

function commandOutput(result: {
  stdout?: string
  stderr?: string
  error?: string | null
  exitCode?: number | null
  timedOut?: boolean
  blocked?: boolean
  blockedReason?: string
}): string {
  if (result.blocked) return `命令被拦截：${result.blockedReason}`
  const output = [
    result.stdout && `标准输出：\n${result.stdout}`,
    result.stderr && `标准错误：\n${result.stderr}`,
    result.error && `错误：${result.error}`,
    result.timedOut && '命令执行超时',
    result.exitCode && `退出码：${result.exitCode}`,
  ].filter(Boolean)
  return output.join('\n') || '执行完成（无输出）'
}

export async function POST(req: NextRequest) {
  let body: any = {}
  try { body = await req.json() } catch { return new Response(JSON.stringify({ error: '请求体格式错误' }), { status: 400 }) }

  const { repo = null, tier = '正构', messages, taskId = null } = body
  try {
    validate.array(messages, 'messages', { minLength: 1 })
    if (repo !== null && (typeof repo !== 'string' || !repo.includes('/'))) throw new Error('仓库参数无效')
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), { status: 400 })
  }

  if (!DEEPSEEK_API_KEY) return new Response(JSON.stringify({ error: '服务未配置（DEEPSEEK_API_KEY 未设置）' }), { status: 500 })

  const store = await cookies()
  const token = store.get('gh_access_token')?.value
  const login = store.get('gh_login')?.value ?? 'me'
  if (!token) return new Response(JSON.stringify({ error: '未连接 GitHub' }), { status: 401 })

  const tierCfg = tier === '观照' ? TIER_MAP['正构'] : (TIER_MAP[tier as keyof typeof TIER_MAP] ?? TIER_MAP['正构'])
  const model = tierCfg.model
  const thinking = tierCfg.thinking

  // 鉴权 + 限流/额度闸门（与 /api/chat 共用 guard 层）
  const auth = await resolveAuth()
  const { supabase, userId } = auth
  const gate = await enforceLimits(auth)
  if (gate.response) return gate.response
  const usingBalance = gate.usingBalance

  // ═══════════════════════════════════════════
  // 核心规则：有 repo → 强制 task + workspace。绝不回退 Plan 模式。
  // ═══════════════════════════════════════════

  // 1. 校验 / 兜底创建 Agent Task
  let effectiveTaskId = taskId as string | null
  if (repo && supabase && userId) {
    if (effectiveTaskId) {
      // 校验前端传来的 taskId
      const { data: taskRow } = await supabase.from("agent_tasks")
        .select("id").eq("id", effectiveTaskId).eq("user_id", userId).single()
      if (!taskRow) {
        effectiveTaskId = null
      }
    }
    if (!effectiveTaskId) {
      // 后端兜底创建 task
      const lastMsg = (messages as any[])?.at(-1)?.content?.slice(0, 200) || "代码改动"
      const { data: newTask, error: createErr } = await supabase.from("agent_tasks")
        .insert({ user_id: userId, goal: lastMsg, repo, status: "planning", mode: "auto" })
        .select("id").single()
      if (createErr || !newTask) {
        console.error('[code/chat] backend task creation failed', {
          message: createErr?.message,
          code: createErr?.code,
          details: createErr?.details,
          hint: createErr?.hint,
        })
        const detail = createErr?.message || '未知数据库错误'
        return new Response(JSON.stringify({ error: `Agent Task 创建失败：${detail}` }), { status: 500 })
      }
      effectiveTaskId = newTask.id
    }
  }
  const recorder = createRecorder({ supabase, userId, taskId: effectiveTaskId })
  if (effectiveTaskId) await recorder.setTaskStatus("running")

  // 2. 仓库元数据
  let defaultBranch: string | null = null
  let repoIsPrivate = false
  if (repo) {
    const meta = await repoMeta(token, repo)
    if (!meta) return new Response(JSON.stringify({ error: '仓库访问失败，请重新连接 GitHub' }), { status: 502 })
    defaultBranch = meta.defaultBranch
    repoIsPrivate = meta.isPrivate
  }

  let memContents: string[] = []
  if (repo && userId && supabase) {
    try {
      const { data } = await supabase.from('code_memories').select('content').eq('user_id', userId).eq('repo', repo).order('created_at')
      memContents = (data ?? []).map((r: any) => r.content as string)
    } catch { /* 表未建时静默 */ }
  }

  // 3. 有 repo = 强制 workspace 模式。没有 repo = 新建项目 Plan 模式。
  const hasWorkspace = !!(repo && effectiveTaskId)

  // 4. 强制确保 workspace 存在（在 stream 之前，不在 stream 内部）
  //    有 repo + task → 必须走 workspace。失败则硬停，绝不回退旧 Plan 模式。
  let wsPreReady = false
  if (hasWorkspace && supabase && userId) {
    const detail = await getTaskDetail(supabase, userId, effectiveTaskId!).catch(() => null)
    if (detail && "workspace" in detail) {
      const ws = detail.workspace
      if (ws && (ws.status === "ready" || ws.status === "dirty") && ws.path && existsSync(ws.path)) {
        wsPreReady = true
      }
    }
    if (!wsPreReady) {
      try {
        const lastMsg = (messages as any[])[messages.length - 1]?.content?.slice(0, 200) || "代码改动"
        const result = await createWorkspaceForTask(
          supabase, userId, effectiveTaskId!, token, repo, lastMsg, defaultBranch ?? "main",
        )
        if (result && !("error" in result) && result.path && existsSync(result.path)) {
          wsPreReady = true
        } else if (result && "error" in result) {
          console.error('[code/chat] workspace pre-create failed', result.error)
        }
      } catch (err: any) {
        console.error('[code/chat] workspace pre-create exception', err?.message)
      }
    }
  }
  // 硬停：有 repo 就必须有 workspace，否则立即报错，不回退到旧 Plan 模式
  if (hasWorkspace && !wsPreReady) {
    return new Response(JSON.stringify({ error: 'Workspace 创建失败，无法在当前仓库工作。请刷新页面重试。' }), { status: 500 })
  }

  // 5. 构建系统提示词和工具（repo 存在 = 永远是 workspace 模式）
  const SYSTEM = buildCodeSystem(repo, login, memContents, hasWorkspace)
  const url = chatCompletionsUrl(DEEPSEEK_BASE_URL)

  // 工具描述：有 repo 一律 workspace 话术
  const isWs = !!repo
  const allTools = [
    { type: 'function', function: { name: 'list_files', description: isWs ? '列出 workspace 中的文件列表。' : '列出当前仓库完整文件路径列表。', parameters: { type: 'object', properties: {} } } },
    ...(isWs ? [{ type: 'function', function: { name: 'search_files', description: '在 workspace 全文搜索代码，返回真实文件路径和行号。定位实现、引用或错误来源时优先使用。', parameters: { type: 'object', properties: { query: { type: 'string', description: '要搜索的原文' }, path: { type: 'string', description: '可选，限制在某个子目录' }, case_sensitive: { type: 'boolean', description: '是否区分大小写，默认 false' } }, required: ['query'] } } }] : []),
    { type: 'function', function: { name: 'read_file', description: isWs ? '读取 workspace 中文件的完整内容。修改前必须先读。' : '读取当前仓库某文件的真实完整内容。修改前必须先读。', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
    { type: 'function', function: { name: 'create_repo', description: '新建一个 GitHub 仓库（做新项目时用）。', parameters: { type: 'object', properties: { name: { type: 'string', description: '英文小写连字符，如 pomodoro-timer' }, description: { type: 'string' }, private: { type: 'boolean', description: '是否私有，默认 false' } }, required: ['name'] } } },
    { type: 'function', function: { name: 'write_files', description: isWs ? '直接在 workspace 中写入真实文件（会自动 snapshot 备份）。传完整文件内容。' : '生成改动计划，用户确认后执行。传完整文件内容。', parameters: { type: 'object', properties: { files: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string', description: '完整文件内容' } }, required: ['path', 'content'] } } }, required: ['files'] } } },
    { type: 'function', function: { name: 'edit_file', description: isWs ? '直接在 workspace 中精确修改文件（会自动 snapshot 备份）。传 old_string 和 new_string。' : '生成改动计划，用户确认后执行。用 old_string 定位原文，替换成 new_string。', parameters: { type: 'object', properties: { path: { type: 'string', description: '文件路径' }, old_string: { type: 'string', description: '原文片段（必须唯一）' }, new_string: { type: 'string', description: '替换内容' } }, required: ['path', 'old_string', 'new_string'] } } },
    { type: 'function', function: { name: 'delete_files', description: isWs ? '直接从 workspace 中删除真实文件（会自动 snapshot 备份）。' : '生成删除计划，用户确认后执行。', parameters: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' } } }, required: ['paths'] } } },
    { type: 'function', function: { name: 'execute', description: isWs ? '在 workspace 中执行命令（node --check、npm run build、npm test 等）。改完代码后建议先跑校验。' : '在沙箱中执行命令（node --check、node -e、python3 -c 等）。', parameters: { type: 'object', properties: { command: { type: 'string', description: '要执行的命令' } }, required: ['command'] } } },
    { type: 'function', function: { name: 'enable_pages', description: '对纯静态/前端项目开启 GitHub Pages，让项目有可访问网址（上线）。', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'code_remember', description: '记住一条关于本仓库的长期事实。', parameters: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'] } } },
    { type: 'function', function: { name: 'search', description: '网络搜索（文档、API、技术资料等）。需要查阅外部资源时用。', parameters: { type: 'object', properties: { query: { type: 'string', description: '搜索关键词或短语' } }, required: ['query'] } } },
    { type: 'function', function: { name: 'fetch_url', description: '打开指定公开网址并读取正文。用于深入阅读搜索结果、文档或检查公开页面内容。', parameters: { type: 'object', properties: { url: { type: 'string', description: '完整的 http 或 https 网址' } }, required: ['url'] } } },
    { type: 'function', function: { name: 'apply_patch', description: isWs ? '直接在 workspace 中应用 unified diff patch 批量修改代码（推荐！）。先传 dryRun: true 预览；确认后传 dryRun: false 执行。' : '应用 unified diff patch 批量修改代码。仅在 workspace 模式下可用。', parameters: { type: 'object', properties: { patch: { type: 'string', description: 'unified diff 格式的 patch 内容' }, dryRun: { type: 'boolean', description: '是否仅预览（dry-run），默认 false' } }, required: ['patch'] } } },
    ...(isWs ? [{ type: 'function', function: { name: 'git_diff', description: '查看 workspace 当前完整 git diff 和变更文件。修改后、发布前必须用它核对真实改动。', parameters: { type: 'object', properties: {} } } }] : []),
    ...(isWs ? [{ type: 'function', function: { name: 'verify', description: '自动识别项目并运行可用的 lint、类型检查、测试和构建。默认在需要时安装依赖；发布前必须验证通过。', parameters: { type: 'object', properties: { install: { type: 'boolean', description: '缺少依赖时是否自动安装，默认 true' }, steps: { type: 'array', items: { type: 'string', enum: ['lint', 'typecheck', 'test', 'build'] }, description: '可选，只运行指定检查；默认运行全部可用检查' } } } } }] : []),
    ...(isWs ? [{ type: 'function', function: { name: 'publish', description: '文件改动和测试完成后请求用户确认发布。普通代码任务创建 PR；用户要求网页上线时 deploy_pages 必须为 true，确认后平台会通过 PR 合并并完成 Pages 部署。绝不直推 main。', parameters: { type: 'object', properties: { deploy_pages: { type: 'boolean', description: '用户要求网页上线或提供可访问网址时必须为 true' } }, required: ['deploy_pages'] } } }] : []),
    ...(isWs ? [{ type: 'function', function: { name: 'check_deployment', description: '检查 GitHub Pages 是否构建完成并且网页确实可以访问。部署未完成时继续检查，不要让用户代替你检查。', parameters: { type: 'object', properties: {} } } }] : []),
    { type: 'function', function: { name: 'complete', description: '只有整个任务已经完成并验证后才能调用。仍有文件改动、待确认发布或待部署时禁止调用。', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'ask_user', description: '只有缺少权限、缺少必要信息或必须由用户做决定时才能调用。普通技术问题必须自己解决。', parameters: { type: 'object', properties: { question: { type: 'string', description: '只问一个用户能直接回答的问题' }, reason: { type: 'string', description: '说明为什么 Agent 无法自行继续' } }, required: ['question', 'reason'] } } },
  ]
  const unavailable = new Set(isWs ? ['create_repo', 'enable_pages'] : ['apply_patch', 'publish'])
  const tools = allTools.filter(tool => !unavailable.has(tool.function.name))

  const stream = new ReadableStream({
    async start(controller) {
      const emit: Emit = (e) => send(controller, e)
      let totalTokensUsed = 0
      const shaCache = new Map<string, string>()  // path → 读过的旧内容（给前端做 diff）
      const msgs: any[] = [{ role: 'system', content: SYSTEM }, ...toOpenAI(messages)]

      // ── Workspace：已在上方 pre-create，这里直接用 ──
      // 送回 taskId 给前端（后端可能兜底创建了新的）
      if (effectiveTaskId) {
        send(controller, { taskId: effectiveTaskId })
      }

      const wsReady = hasWorkspace && wsPreReady
      const wsTaskId = effectiveTaskId ?? ""
      const wsUserId = userId ?? ""
      let usedTools = false
      let publishCalled = false
      let completed = false
      let waitingForUser = false
      let plannedRepo = false
      let plannedFiles = 0
      let verifiedDiff: string | null = null

      const workspaceHasChanges = () => {
        if (!wsReady) return false
        const changed = getChangedFiles(wsTaskId, wsUserId)
        return changed.ok && changed.data.files.length > 0
      }

      const executeTool: ExecuteTool = async (name, input) => {
        if (name !== 'complete') usedTools = true
        if (name === 'list_files') {
          // 如果有 workspace，列 workspace 文件；否则走 GitHub
          if (wsReady) {
            emit({ step: { kind: 'list', label: '浏览 workspace 文件' } })
            const { listWorkspaceFiles } = await import('@/lib/agent/workspace')
            const res = listWorkspaceFiles(wsTaskId, wsUserId)
            if (res.ok) return `Workspace 共 ${res.data.total} 个文件${res.data.truncated ? '（已截断）' : ''}：\n${res.data.files.join('\n')}`
            return `列出文件失败：${res.error}`
          }
          if (!repo) return '尚未选择仓库。'
          emit({ step: { kind: 'list', label: '浏览仓库文件结构' } })
          const { paths, truncated } = await listTree(token!, repo, defaultBranch!)
          if (!paths.length) return '仓库为空或无法获取文件列表。'
          return `仓库共 ${paths.length} 个文件${truncated ? '（已截断）' : ''}：\n${paths.join('\n')}`
        }
        if (name === 'search_files') {
          if (!wsReady) return 'search_files 需要 workspace。'
          const query = String(input?.query ?? '').trim()
          if (!query) return '缺少 query。'
          emit({ step: { kind: 'read', label: `搜索代码：${query.slice(0, 50)}` } })
          const result = searchWorkspaceFiles(wsTaskId, wsUserId, query, {
            path: typeof input?.path === 'string' ? input.path : undefined,
            caseSensitive: input?.case_sensitive === true,
          })
          if (!result.ok) return `搜索失败：${result.error}`
          if (!result.data.matches.length) return `已搜索 ${result.data.searchedFiles} 个文件，没有找到“${query}”。`
          return `找到 ${result.data.matches.length} 处匹配${result.data.truncated ? '（结果已截断）' : ''}：\n${result.data.matches.join('\n')}`
        }
        if (name === 'read_file') {
          const path = String(input?.path ?? '').trim()
          if (!path) return '缺少 path。'
          emit({ step: { kind: 'read', label: `读取 ${path}` } })

          // Workspace 优先
          if (wsReady) {
            const res = readWorkspaceFile(wsTaskId, wsUserId, path)
            if (!res.ok) return `读取失败：${res.error}`
            shaCache.set(path, res.data.content)
            return `文件 ${path} 内容：\n\`\`\`\n${res.data.content}\n\`\`\``
          }

          if (!repo) return '尚未选择仓库。'
          const r = await readFile(token!, repo, path)
          if ('error' in r) return `读取失败：${r.error}`
          shaCache.set(path, r.content)
          return `文件 ${path} 内容：\n\`\`\`\n${r.content}\n\`\`\``
        }
        if (name === 'create_repo') {
          const name2 = String(input?.name ?? '').trim()
          if (!name2) return '缺少仓库名。'
          emit({ step: { kind: 'repo', label: `新建仓库 ${name2}` } })
          emit({ plan: { kind: 'create_repo', name: name2, description: String(input?.description ?? ''), private: !!input?.private } })
          plannedRepo = true
          return `已加入计划：新建仓库 ${login}/${name2}。继续写入文件。`
        }
        if (name === 'write_files') {
          const files = Array.isArray(input?.files) ? input.files : []
          if (!files.length) return '没有要写的文件。'

          // Workspace 优先：直接写文件
          if (wsReady) {
            const results: string[] = []
            for (const f of files) {
              const path = String(f?.path ?? '').trim()
              const content = String(f?.content ?? '')
              if (!path) continue
              emit({ step: { kind: 'edit', label: `写入 ${path}` } })
              const res = await writeWorkspaceFile(wsTaskId, wsUserId, path, content, supabase ?? undefined)
              if (res.ok) {
                shaCache.set(path, content)
                results.push(`✅ ${path}（${res.data.created ? '新建' : '覆盖'}）\n${res.data.diff.slice(0, 500)}`)
              } else {
                results.push(`❌ ${path}：${res.error}`)
              }
            }
            const changed = getChangedFiles(wsTaskId, wsUserId)
            const changedList = changed.ok ? changed.data.files.map(f => `  ${f.status} ${f.path}`).join('\n') : ''
            return `已在 workspace 写入 ${files.length} 个文件：\n${results.join('\n')}\n\n变更文件：\n${changedList || '（无变更）'}`
          }

          // 旧行为：生成 plan
          for (const f of files) {
            const path = String(f?.path ?? '').trim()
            const content = String(f?.content ?? '')
            if (!path) continue
            // 取旧内容做 diff（已读过用缓存；没读过且选了仓库就现读；否则当新文件）
            let oldContent = shaCache.get(path) ?? ''
            if (!oldContent && repo) {
              const r = await readFile(token!, repo, path)
              if (!('error' in r)) oldContent = r.content
            }
            emit({ step: { kind: 'edit', label: `写入 ${path}` } })
            emit({ plan: { kind: 'write_file', path, oldContent, newContent: content } })
            plannedFiles++
          }
          return `已加入计划：写入 ${files.length} 个文件（等待用户确认/自动执行）。`
        }
        if (name === 'edit_file') {
          const path = String(input?.path ?? '').trim()
          const oldString = String(input?.old_string ?? '')
          const newString = String(input?.new_string ?? '')
          if (!path || !oldString) return '缺少 path 或 old_string。'
          emit({ step: { kind: 'edit', label: `编辑 ${path}` } })

          // Workspace 优先
          if (wsReady) {
            const res = await editWorkspaceFile(wsTaskId, wsUserId, path, oldString, newString, supabase ?? undefined)
            if (!res.ok) return `编辑失败：${res.error}`
            return `✅ 已在 workspace 编辑 ${path}（替换 1 处）\n${res.data.diff.slice(0, 500)}`
          }

          if (!repo) return '尚未选择仓库。'
          const r = await readFile(token!, repo, path)
          if ('error' in r) return `读取失败：${r.error}`
          const content = r.content
          const idx = content.indexOf(oldString)
          if (idx === -1) return `在 ${path} 中找不到指定字符串（区分大小写）。请用 read_file 确认准确内容后重试。`
          if (content.indexOf(oldString, idx + 1) !== -1) return `在 ${path} 中找到多处匹配，请提供更精确的上下文。`
          const newContent = content.slice(0, idx) + newString + content.slice(idx + oldString.length)
          shaCache.set(path, content)
          emit({ plan: { kind: 'write_file', path, oldContent: content, newContent } })
          return `已加入计划：编辑 ${path}（替换 1 处内容）。`
        }
        if (name === 'delete_files') {
          const paths = Array.isArray(input?.paths) ? input.paths : []

          // Workspace 优先
          if (wsReady) {
            const results: string[] = []
            for (const p of paths) {
              const path = String(p ?? '').trim()
              if (!path) continue
              emit({ step: { kind: 'edit', label: `删除 ${path}` } })
              const res = await deleteWorkspaceFile(wsTaskId, wsUserId, path, supabase ?? undefined)
              results.push(res.ok ? `✅ 删除 ${path}` : `❌ ${path}：${res.error}`)
            }
            return `已在 workspace 删除文件：\n${results.join('\n')}`
          }

          // 旧行为：生成 plan
          for (const p of paths) {
            const path = String(p ?? '').trim()
            if (!path) continue
            emit({ step: { kind: 'edit', label: `删除 ${path}` } })
            emit({ plan: { kind: 'delete_file', path } })
          }
          return `已加入计划：删除 ${paths.length} 个文件。`
        }
        if (name === 'enable_pages') {
          emit({ step: { kind: 'deploy', label: '开启 GitHub Pages 上线' } })
          emit({ plan: { kind: 'enable_pages' } })
          return '已加入计划：开启 GitHub Pages。'
        }
        if (name === 'execute') {
          const command = String(input?.command ?? '').trim()
          if (!command) return '缺少 command。'
          emit({ step: { kind: 'read', label: `执行：${command.slice(0, 60)}` } })

          if (wsReady && supabase) {
            const result = await runInWorkspace(supabase, wsUserId, wsTaskId, command)
            return commandOutput(result)
          }

          try {
            return commandOutput(runInSandbox(command))
          } catch (err: any) {
            return `沙箱执行异常：${err?.message ?? '未知错误'}`
          }
        }
        if (name === 'verify') {
          if (!wsReady || !supabase) return 'verify 需要 workspace。'
          const allowed = new Set(['lint', 'typecheck', 'test', 'build'])
          const requested = Array.isArray(input?.steps)
            ? input.steps.filter((step: unknown) => typeof step === 'string' && allowed.has(step))
            : undefined
          emit({ step: { kind: 'read', label: '自动验证项目' } })
          const result = await runVerification(wsTaskId, wsUserId, supabase, {
            install: input?.install !== false,
            steps: requested?.length ? requested : undefined,
          })
          verifiedDiff = result.ok ? getWorkspaceDiff(wsTaskId, wsUserId) : null
          const steps = result.steps.map(step => `${step.name}: ${step.skipped ? '跳过' : step.passed ? '通过' : '失败'}`).join('\n')
          const failed = result.steps.find(step => !step.passed)
          const detail = failed ? redactSensitive(failed.stderr || failed.stdout).slice(0, 6000) : ''
          return `${result.summary}\n${steps}${detail ? `\n\n失败详情：\n${detail}` : ''}`
        }
        if (name === 'code_remember') {
          const content = String(input?.content ?? '').trim()
          if (!content || !repo) return content ? '尚未选择仓库，无法记忆。' : '内容为空。'
          let ok = false
          if (userId && supabase) {
            try { const { error } = await supabase.from('code_memories').insert({ user_id: userId, repo, content }); ok = !error } catch { ok = false }
          }
          emit({ step: { kind: 'memory', label: `记住：${content.slice(0, 40)}` } })
          return ok ? '已记住。' : '记忆保存失败（可能未建表）。'
        }
        if (name === 'apply_patch') {
          const patch = String(input?.patch ?? '').trim()
          if (!patch) return '缺少 patch 内容。'
          const dryRun = input?.dryRun === true

          // Workspace 专用
          if (wsReady) {
            emit({ step: { kind: 'edit', label: dryRun ? 'apply_patch (dry-run)' : 'apply_patch' } })
            if (dryRun) {
              const res = dryRunWorkspacePatch(wsTaskId, wsUserId, patch)
              if (!res.ok) return `❌ Dry-run 失败：${res.error}`
              return `✅ Dry-run 通过：${res.changedFiles.length} 个文件将被修改\n${res.diffSummary.slice(0, 2000)}`
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
          emit({ step: { kind: 'read', label: '查看真实 git diff' } })
          const changed = getChangedFiles(wsTaskId, wsUserId)
          const files = changed.ok ? changed.data.files.map(file => `${file.status} ${file.path}`).join('\n') : ''
          const diff = redactSensitive(getWorkspaceDiff(wsTaskId, wsUserId)).slice(0, 30000)
          return diff ? `变更文件：\n${files}\n\n真实 diff：\n${diff}` : 'Workspace 当前没有改动。'
        }
        if (name === 'publish') {
          if (!wsReady) return 'publish 需要 workspace。当前没有就绪的 workspace。'
          if (verifiedDiff === null || verifiedDiff !== getWorkspaceDiff(wsTaskId, wsUserId)) {
            return '当前改动还没有通过最新一轮自动验证。先调用 verify；失败就修复并重新验证。'
          }
          emit({ step: { kind: 'deploy', label: '准备发布' } })
          // 检查是否有改动
          const changed = getChangedFiles(wsTaskId, wsUserId)
          const fileList = changed.ok ? changed.data.files.map(f => `  ${f.status} ${f.path}`).join('\n') : ''
          if (!fileList) return 'Workspace 还没有文件改动，不能发布。继续完成原始任务。'
          const task = await getTaskDetail(supabase!, wsUserId, wsTaskId)
          if (!("workspace" in task)) return '无法读取任务状态，暂时不能发布。'
          const deployPages = input?.deploy_pages === true
          const { error: metaError } = await supabase!.from('agent_tasks').update({
            meta: { ...(task.meta ?? {}), deployPages },
            updated_at: new Date().toISOString(),
          }).eq('id', wsTaskId).eq('user_id', wsUserId)
          if (metaError) return `保存发布目标失败：${metaError.message}`
          publishCalled = true
          return `改动已就绪，等待用户确认发布。

变更文件：
${fileList || '（请先修改文件）'}

下一步：用户在底部点击「确认发布」按钮，平台后端会自动：
1. git commit 所有改动
2. push agent branch 到 GitHub
3. 创建 Pull Request${deployPages ? '\n4. 通过 Pull Request 合并到 main\n5. 开启 GitHub Pages 并等待网页可访问' : ''}

不会直接推送到 main 分支。`
        }
        if (name === 'complete') {
          if (wsReady && !usedTools) return '还没有执行任何检查，不能直接宣布完成。先核对仓库或发布结果。'
          if (wsReady && workspaceHasChanges()) return 'Workspace 仍有未发布改动，不能完成。先测试并调用 publish。'
          if (!wsReady && (!plannedRepo || plannedFiles === 0)) return '新项目计划还不完整，不能完成。'
          if (wsReady) {
            const task = await getTaskDetail(supabase!, wsUserId, wsTaskId)
            if ("workspace" in task && task.meta?.deployPages === true && task.meta?.deploymentStatus !== 'ready') {
              return '网页还没有确认可访问，不能完成。继续调用 check_deployment；如果构建失败，主动排查并修复。'
            }
          }
          completed = true
          return '任务已明确标记为完成。请给出最终结果，不要再提出未完成事项。'
        }
        if (name === 'check_deployment') {
          if (!wsReady || !repo) return '当前没有可检查的网页部署。'
          emit({ step: { kind: 'deploy', label: '检查网页部署' } })
          const task = await getTaskDetail(supabase!, wsUserId, wsTaskId)
          const expectedCommitSha = "workspace" in task && typeof task.meta?.mergeCommitSha === 'string'
            ? task.meta.mergeCommitSha
            : undefined
          const pages = await waitForPages(token!, repo, {
            verifyUrl: !repoIsPrivate,
            expectedCommitSha,
          })
          if ("workspace" in task) {
            await supabase!.from('agent_tasks').update({
              meta: {
                ...(task.meta ?? {}),
                deploymentStatus: pages.status,
                pagesUrl: pages.url,
                deploymentError: pages.status === 'failed' ? pages.error : null,
              },
              updated_at: new Date().toISOString(),
            }).eq('id', wsTaskId).eq('user_id', wsUserId)
          }
          if (pages.status === 'ready') return `网页已经构建完成并可访问：${pages.url}`
          if (pages.status === 'failed') return `网页部署失败：${pages.error}。请主动排查原因并修复。`
          return `网页仍在部署：${pages.url}。任务尚未完成，请继续检查。`
        }
        if (name === 'ask_user') {
          const question = String(input?.question ?? '').trim()
          const reason = String(input?.reason ?? '').trim()
          if (!question || !reason) return '必须说明具体问题和无法自行继续的原因。'
          waitingForUser = true
          return `需要用户处理：${question}\n原因：${reason}`
        }
        if (name === 'search') {
          const query = String(input?.query ?? '').trim()
          if (!query) return '查询为空。'
          if (!TAVILY_API_KEY) return '搜索功能未配置。'
          emit({ step: { kind: 'read', label: `搜索：${query}` } })
          try {
            const res = await fetch('https://api.tavily.com/search', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ api_key: TAVILY_API_KEY, query, max_results: 5, include_answer: true }),
            }).catch(() => null)
            if (!res?.ok) return '搜索失败'
            const data = await res.json()
            const answer = (data.answer as string) ?? ''
            const results = (data.results as any[]) ?? []
            let out = answer ? `直接回答：${answer}\n\n` : ''
            if (results.length) {
              out += '相关资源：\n'
              results.forEach((r: any, i: number) => {
                out += `${i + 1}. ${r.title ?? r.url}\n   ${(r.content as string)?.slice(0, 200)}\n   来源：${r.url}\n`
              })
            }
            return out || '未找到相关结果。'
          } catch { return '搜索异常。' }
        }
        if (name === 'fetch_url') {
          const url = String(input?.url ?? '').trim()
          if (!url) return '网址为空。'
          emit({ step: { kind: 'read', label: `读取网页：${url.slice(0, 60)}` } })
          return readPage(url)
        }
        return '未知工具。'
      }

      let loopFailed = false
      try {
        const { totalTokens } = await runAgentLoop({
          url, apiKey: DEEPSEEK_API_KEY, model, adapter: 'deepseek-openai', thinking,
          messages: msgs, tools, emit, executeTool,
          leakedRetry: true,
          autoContinue: {},
          idleContinuation: {
            prompt: () => codeContinuationPrompt({
              workspace: wsReady,
              usedTools,
              hasChanges: workspaceHasChanges(),
              published: publishCalled,
              completed,
              waitingForUser,
              plannedRepo,
              plannedFiles,
            }),
          },
          onTurn: ({ phase, round, turn }) => {
            log.info('codeChat', `Turn ${phase}`, { round, finishReason: turn.finishReason, leaked: turn.leaked, toolCalls: turn.toolCalls.length, contentLen: turn.content.length, truncated: turn.truncated })
          },
        })
        totalTokensUsed += totalTokens
      } catch (error) {
        loopFailed = true
        emit({ error: networkError(error) })
      } finally {
        if (effectiveTaskId) {
          const status = loopFailed
            ? "failed"
            : waitingForUser || publishCalled || workspaceHasChanges() ? "waiting_for_user" : "completed"
          await recorder.setTaskStatus(status)
        }
        if (userId && supabase) await addQuotaUsage(supabase, userId, totalTokensUsed, model, thinking, usingBalance)
        done(controller)
      }
    },
  })

  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } })
}
