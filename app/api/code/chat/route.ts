import { NextRequest } from 'next/server'
import { cookies } from 'next/headers'
import { TIER_MAP } from '@/lib/chat-data'
import { send, done, networkError } from '@/lib/llm/stream'
import { toOpenAI, chatCompletionsUrl } from '@/lib/llm/openai'
import { runAgentLoop, type ExecuteTool } from '@/lib/llm/agent-loop'
import type { Emit } from '@/lib/llm/events'
import { repoMeta } from '@/lib/github'
import { log } from '@/lib/logger'
import { validate } from '@/lib/validation'
import { addQuotaUsage } from '@/lib/quota'
import { resolveAuth, enforceLimits } from '@/lib/api/guard'
import { isolatedShellConfigured, startAgentRecoveryWatchdog } from '@/lib/agent/isolated-shell'
import { createRecorder } from '@/lib/agent/recorder'
import { codeContinuationPrompt } from '@/lib/agent/continuation'
import { saveWorkspaceCheckpoint } from '@/lib/agent/checkpoint'
import { saveAgentRunState } from '@/lib/agent/run-state'
import { isInternalRecoveryToken, sealRecoveryToken } from '@/lib/agent/recovery-token'
import {
  getChangedFiles,
  createWorkspaceForTask,
} from '@/lib/agent/workspace'
import { getTaskDetail } from '@/lib/agent/data'
import { buildCodeTools, createCodeToolExecutor } from '@/lib/code-tools'
import { existsSync } from 'fs'

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY ?? ''
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com'
const TAVILY_API_KEY = process.env.TAVILY_API_KEY ?? ''

function buildCodeSystem(repo: string | null, login: string, memories: string[], hasWorkspace: boolean): string {
  const executePermission = isolatedShellConfigured()
    ? '在当前任务独享的 Linux 沙箱中执行完整终端命令；服务器密钥不会进入沙箱'
    : '在 workspace 里执行受控命令（node --check、npm run build、npm test 等）'
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
- execute：${executePermission}
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
  s += `\n\n【执行纪律】
- 只要你准备说“还需要、接下来、尚未、下一步、让我继续”，就说明任务没有完成；禁止把这句话交给用户，必须在同一轮立刻继续调用工具。
- 安装依赖、构建、测试、验证、修复报错、重试命令、检查 diff 都是你自己的工作，不得调用 ask_user，不得暂停。
- 工具失败后先读取错误并自主修复；同一方案失败就换方案，不能只解释错误。
- ask_user 只允许用于确实缺少登录/授权/密钥，或存在互斥的产品选择。请求用户说“继续”不是有效问题。
- 只有三种情况可以停：publish 等待用户确认；ask_user 报告真实外部阻塞；complete 表示整个目标已验证完成。`
  return s
}

export async function POST(req: NextRequest) {
  let body: any = {}
  try { body = await req.json() } catch { return new Response(JSON.stringify({ error: '请求体格式错误' }), { status: 400 }) }

  const { repo = null, tier = '正构', messages, taskId = null, responseId = null, sessionId = null } = body
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

  if (effectiveTaskId && supabase && userId && repo) {
    await saveAgentRunState(supabase, userId, effectiveTaskId, {
      repo,
      tier,
      messages,
      responseId: typeof responseId === 'string' ? responseId : undefined,
      sessionId: typeof sessionId === 'string' ? sessionId : undefined,
      updatedAt: new Date().toISOString(),
    })
    const cookie = req.headers.get('cookie') ?? ''
    const recoveryToken = sealRecoveryToken({ taskId: effectiveTaskId, cookie, expiresAt: Date.now() + 2 * 60 * 60_000 })
    if (recoveryToken && !isInternalRecoveryToken(req.headers.get('x-agent-recovery'))) {
      const origin = process.env.AGENT_PUBLIC_URL?.trim() || req.nextUrl.origin
      await startAgentRecoveryWatchdog(
        supabase,
        userId,
        effectiveTaskId,
        `${origin}/api/agent/tasks/${effectiveTaskId}/recover`,
        recoveryToken,
      ).catch(error => log.warn('codeChat', 'Recovery watchdog unavailable', { error: String(error) }))
    }
  }

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
  const executePermission = isolatedShellConfigured()
    ? '在当前任务独享的 Linux 沙箱中执行完整终端命令'
    : '在 workspace 中执行受控命令'
  const tools = buildCodeTools({ isWorkspace: isWs, executePermission })

  let clientConnected = true
  const stream = new ReadableStream({
    async start(controller) {
      let finalText = ''
      const safeSend = (data: object) => {
        if (!clientConnected) return
        try { send(controller, data) } catch { clientConnected = false }
      }
      const streamHeartbeat = setInterval(() => {
        safeSend({ heartbeat: true })
      }, 8_000)
      const emit: Emit = (event) => {
        if ('text' in event) finalText += event.text
        if ('error' in event) finalText = `${finalText}${finalText ? '\n\n' : ''}${event.error}`
        if ('step' in event) void recorder.step(event.step.kind, event.step.label)
        safeSend(event)
      }
      let totalTokensUsed = 0
      const canResume = isInternalRecoveryToken(req.headers.get('x-agent-recovery'))
      const resumed = canResume && Array.isArray(body.resumeMessages) ? body.resumeMessages : null
      const msgs: any[] = [{ role: 'system', content: SYSTEM }, ...(resumed ?? toOpenAI(messages))]

      // ── Workspace：已在上方 pre-create，这里直接用 ──
      // 送回 taskId 给前端（后端可能兜底创建了新的）
      if (effectiveTaskId) {
        safeSend({ taskId: effectiveTaskId })
      }

      const wsReady = hasWorkspace && wsPreReady
      const wsTaskId = effectiveTaskId ?? ""
      const wsUserId = userId ?? ""
      let usedTools = false
      let publishCalled = false
      let completed = false
      let waitingForUser = false
      let cancelled = false
      let plannedRepo = false
      let plannedFiles = 0
      let verifiedDiff: string | null = null

      const workspaceHasChanges = () => {
        if (!wsReady) return false
        const changed = getChangedFiles(wsTaskId, wsUserId)
        return changed.ok && changed.data.files.length > 0
      }

      const executeToolImpl = createCodeToolExecutor({
        repo,
        login,
        token: token!,
        defaultBranch,
        repoIsPrivate,
        supabase,
        userId,
        wsReady,
        wsTaskId,
        wsUserId,
        tavilyApiKey: TAVILY_API_KEY,
        emit,
        state: {
          markUsedTool: () => { usedTools = true },
          hasUsedTools: () => usedTools,
          markPlannedRepo: () => { plannedRepo = true },
          hasPlannedRepo: () => plannedRepo,
          addPlannedFiles: (count = 1) => { plannedFiles += count },
          getPlannedFiles: () => plannedFiles,
          markPublishCalled: () => { publishCalled = true },
          hasPublishCalled: () => publishCalled,
          markCompleted: () => { completed = true },
          markWaitingForUser: () => { waitingForUser = true },
          getVerifiedDiff: () => verifiedDiff,
          setVerifiedDiff: (diff) => { verifiedDiff = diff },
          workspaceHasChanges,
        },
      })

      const checkpointTools = new Set(['write_files', 'edit_file', 'delete_files', 'apply_patch', 'execute', 'verify'])
      const executeTool: ExecuteTool = async (name, input) => {
        if (cancelled) throw new Error('任务已取消')
        const run = () => executeToolImpl(name, input)
        const result = name === 'execute' ? await run() : await recorder.recordToolCall(name, input, run)
        const shouldCheckpoint = wsReady && checkpointTools.has(name) && !(name === 'apply_patch' && input?.dryRun === true)
        if (shouldCheckpoint && supabase) {
          const checkpoint = await saveWorkspaceCheckpoint(supabase, wsUserId, wsTaskId)
          if (!checkpoint.ok) await recorder.step('error', '后台检查点保存失败', checkpoint.error)
        }
        return result
      }

      let loopFailed = false
      const heartbeat = setInterval(() => {
        if (!effectiveTaskId || !supabase || !userId) return
        void supabase.from('agent_tasks').update({ status: 'running', updated_at: new Date().toISOString() })
          .eq('id', effectiveTaskId).eq('user_id', userId).neq('status', 'cancelled')
          .select('status')
          .then(({ data }) => { if (Array.isArray(data) && data.length === 0) cancelled = true })
      }, 15_000)
      try {
        const { totalTokens } = await runAgentLoop({
          url, apiKey: DEEPSEEK_API_KEY, model, adapter: 'deepseek-openai', thinking,
          messages: msgs, tools, emit, executeTool,
          leakedRetry: true,
          autoContinue: {},
          idleContinuation: {
            prompt: ({ idleCount }) => {
              const state = {
                workspace: wsReady,
                usedTools,
                hasChanges: workspaceHasChanges(),
                published: publishCalled,
                completed,
                waitingForUser,
                plannedRepo,
                plannedFiles,
              }
              const prompt = codeContinuationPrompt(state)
              log.info('codeChat', 'Idle decision', { idleCount, ...state, continuing: Boolean(prompt) })
              return prompt
            },
          },
          onTurn: ({ phase, round, turn }) => {
            log.info('codeChat', `Turn ${phase}`, { round, finishReason: turn.finishReason, leaked: turn.leaked, tools: turn.toolCalls.map(call => call.name), contentLen: turn.content.length, truncated: turn.truncated })
          },
          onCheckpoint: async latestMessages => {
            if (effectiveTaskId && supabase && userId) {
              await saveAgentRunState(supabase, userId, effectiveTaskId, { resumeMessages: latestMessages.slice(1) })
            }
          },
        })
        totalTokensUsed += totalTokens
      } catch (error) {
        loopFailed = true
        if (!cancelled) emit({ error: networkError(error) })
      } finally {
        clearInterval(streamHeartbeat)
        clearInterval(heartbeat)
        if (effectiveTaskId) {
          if (supabase && userId) {
            const { data } = await supabase.from('agent_tasks').select('status').eq('id', effectiveTaskId).eq('user_id', userId).single()
            cancelled = data?.status === 'cancelled'
          }
          if (!cancelled) {
            const status = loopFailed
              ? "failed"
              : completed ? "completed"
              : waitingForUser || publishCalled ? "waiting_for_user" : "running"
            await recorder.setTaskStatus(status)
          }
          if (finalText.trim()) {
            await recorder.artifact('summary', {
              title: 'Code Agent 回复',
              content: finalText,
              meta: { responseId, sessionId, completed, waitingForUser, publishCalled },
            })
          }
          if (supabase && userId && typeof responseId === 'string' && typeof sessionId === 'string' && finalText.trim()) {
            await supabase.from('code_messages').delete().eq('id', responseId).eq('user_id', userId)
            await supabase.from('code_messages').insert({
              id: responseId,
              session_id: sessionId,
              user_id: userId,
              role: 'assistant',
              content: finalText,
              meta: { taskId: effectiveTaskId },
            })
          }
        }
        if (userId && supabase) await addQuotaUsage(supabase, userId, totalTokensUsed, model, thinking, usingBalance)
        if (clientConnected) {
          try { done(controller) } catch { clientConnected = false }
        }
      }
    },
    cancel() { clientConnected = false },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}
