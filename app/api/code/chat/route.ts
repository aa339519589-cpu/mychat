import { NextRequest } from 'next/server'
import { cookies } from 'next/headers'
import { createClient } from '@/lib/supabase/server'
import { TIER_MAP } from '@/lib/chat-data'
import { send, done, networkError } from '@/lib/llm/stream'
import { toOpenAI, chatCompletionsUrl, runOpenAITurn } from '@/lib/llm/openai'
import { listTree, readFile, repoMeta } from '@/lib/github'
import { log } from '@/lib/logger'
import { validate } from '@/lib/validation'
import { checkRateLimit } from '@/lib/rate-limit'
import { checkQuotaExceeded, addQuotaUsage } from '@/lib/quota'

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY ?? ''
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com'

// Code 是 agentic：模型要先浏览、再读文件、才能改。给足轮次。/goal 自主模式给更多。
const ROUNDS_NORMAL = 8
const ROUNDS_GOAL = 20
const MAX_FILE_READS = 24      // 单次请求最多读这么多文件，防失控
const MAX_PROPOSED_EDITS = 5   // 单次 PR 最多 5 个文件

function buildCodeSystem(repo: string, defaultBranch: string, memories: string[], goal: boolean): string {
  let s = `你是「小克 · 代码」，一个能真正读写 GitHub 仓库的编程助手，运行在用户自建网页应用的 Code 板块里。

当前仓库：${repo}（默认分支 ${defaultBranch}）。这是真实代码，不是示例。

你拥有以下工具，必须靠它们自己定位问题，不要让用户告诉你文件路径或行号：
- list_files：列出仓库完整文件路径。开始排查前先调用它了解结构。
- read_file：读取某个文件的真实内容。修改前必须先读，了解上下文。
- propose_edit：提出对某个文件的修改。传入修改后的【完整文件内容】（不要省略任何未改动的行）。这一步只生成「修改前 vs 修改后」的对比给用户看，不会真正写入——必须等用户在界面上点「确认提交」才会建分支、提交、开 PR。
- code_remember：当你了解到关于本仓库的、值得长期记住的事实（架构约定、技术栈、易错点、用户偏好），调用它记下来。这份记忆只属于本仓库的 Code 板块。

工作方式：
1. 用户描述一个问题或需求（往往不懂代码、说不出文件名）。
2. 你主动 list_files → read_file 若干个最相关的文件，定位真正的根因。
3. 找到后，用 propose_edit 给出完整的修改方案；可对多个文件分别 propose_edit（一次最多 ${MAX_PROPOSED_EDITS} 个文件）。
4. 简明地用中文向用户说明你改了什么、为什么。不要长篇大论，像一个干练的工程师。

约束：
- 绝不直接提交到默认分支；所有改动都通过「新分支 + PR」，且必须用户确认。
- 不确定就先多读几个文件，宁可多看也不要猜。
- 回复用中文，技术术语保留英文。不要用 emoji。`

  if (memories.length) {
    s += `\n\n关于本仓库你已经记住的事（${memories.length} 条）：\n${memories.map(m => `- ${m}`).join('\n')}`
  }
  if (goal) {
    s += `\n\n【目标模式】用户设定了一个目标，希望你自主连续工作、尽可能一次推进到位：充分浏览和阅读相关文件，把需要改的文件都用 propose_edit 提出来，不要中途停下来反问无关紧要的细节。完成后总结你做了哪些改动。`
  }
  return s
}

export async function POST(req: NextRequest) {
  let body: any = {}
  try { body = await req.json() } catch { return new Response(JSON.stringify({ error: '请求体格式错误' }), { status: 400 }) }

  const { repo, tier = '正构', goal = false, messages } = body
  try {
    validate.array(messages, 'messages', { minLength: 1 })
    if (!repo || typeof repo !== 'string' || !repo.includes('/')) throw new Error('缺少有效的仓库')
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), { status: 400 })
  }

  if (!DEEPSEEK_API_KEY) return new Response(JSON.stringify({ error: '服务未配置（DEEPSEEK_API_KEY 未设置）' }), { status: 500 })

  const store = await cookies()
  const token = store.get('gh_access_token')?.value
  if (!token) return new Response(JSON.stringify({ error: '未连接 GitHub' }), { status: 401 })

  const tierCfg = TIER_MAP[tier as keyof typeof TIER_MAP] ?? TIER_MAP['正构']
  const model = tierCfg.model
  const thinking = tierCfg.thinking

  let supabase: any = null
  let userId: string | null = null
  try {
    supabase = await createClient()
    const { data } = await supabase.auth.getUser()
    userId = data.user?.id ?? null
  } catch { supabase = null }

  // 速率限制
  if (userId) {
    const { allowed } = checkRateLimit(userId)
    if (!allowed) return new Response(JSON.stringify({ error: '请求过于频繁，请稍后再试' }), { status: 429 })
  }

  // 额度
  let usingBalance = false
  if (userId && supabase) {
    const q = await checkQuotaExceeded(supabase, userId)
    if (q.exceeded) {
      const window = q.which === '5h' ? '5 小时' : '7 天'
      return new Response(JSON.stringify({ error: `${window}用量已达上限，余额也已耗尽。可在「设置 · 使用额度」充值。` }), { status: 429 })
    }
    usingBalance = q.usingBalance ?? false
  }

  // 校验写权限 + 取默认分支（写操作前置校验，防 token 过期竞态）
  const meta = await repoMeta(token, repo)
  if (!meta) return new Response(JSON.stringify({ error: '仓库访问失败，请重新连接 GitHub' }), { status: 502 })
  const defaultBranch = meta.defaultBranch

  // 取本仓库的 Code 记忆（与系统记忆隔离）
  let memContents: string[] = []
  if (userId && supabase) {
    try {
      const { data } = await supabase.from('code_memories').select('content').eq('user_id', userId).eq('repo', repo).order('created_at')
      memContents = (data ?? []).map((r: any) => r.content as string)
    } catch { /* 表未建时静默 */ }
  }

  const SYSTEM = buildCodeSystem(repo, defaultBranch, memContents, !!goal)
  const url = chatCompletionsUrl(DEEPSEEK_BASE_URL)

  // 工具定义（OpenAI 格式）
  const tools = [
    { type: 'function', function: { name: 'list_files', description: '列出仓库完整文件路径列表（默认分支）。排查前先调用了解结构。', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'read_file', description: '读取仓库中某个文件的真实完整内容。修改前必须先读。', parameters: { type: 'object', properties: { path: { type: 'string', description: '文件路径，如 components/literary-chat.tsx' } }, required: ['path'] } } },
    { type: 'function', function: { name: 'propose_edit', description: '提出对某文件的修改（传修改后的完整内容）。只生成 diff 给用户确认，不会真正写入。', parameters: { type: 'object', properties: { path: { type: 'string' }, new_content: { type: 'string', description: '修改后的完整文件内容，不省略任何行' }, summary: { type: 'string', description: '一句话说明这个文件改了什么' } }, required: ['path', 'new_content', 'summary'] } } },
    { type: 'function', function: { name: 'code_remember', description: '记住一条关于本仓库的长期事实（架构、技术栈、易错点、用户偏好）。', parameters: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'] } } },
  ]

  const maxRounds = goal ? ROUNDS_GOAL : ROUNDS_NORMAL

  const stream = new ReadableStream({
    async start(controller) {
      let totalTokensUsed = 0
      let fileReads = 0
      const proposedPaths = new Set<string>()
      const shaCache = new Map<string, { content: string; sha: string }>()  // path → 读过的内容+sha
      const msgs: any[] = [{ role: 'system', content: SYSTEM }, ...toOpenAI(messages)]

      // 派发一个工具调用，返回回灌模型的文字
      async function execCodeTool(name: string, input: any): Promise<string> {
        if (name === 'list_files') {
          send(controller, { step: { kind: 'list', label: '浏览仓库文件结构' } })
          const { paths, truncated } = await listTree(token!, repo, defaultBranch)
          if (!paths.length) return '无法获取文件列表（可能是空仓库）。'
          return `仓库共 ${paths.length} 个文件${truncated ? '（已截断，仅列出前部分）' : ''}：\n${paths.join('\n')}`
        }
        if (name === 'read_file') {
          const path = String(input?.path ?? '').trim()
          if (!path) return '缺少 path 参数。'
          if (fileReads >= MAX_FILE_READS) return '本次读取文件数已达上限，请基于已读内容继续。'
          fileReads++
          send(controller, { step: { kind: 'read', label: `读取 ${path}` } })
          const r = await readFile(token!, repo, path)
          if ('error' in r) return `读取失败：${r.error}`
          shaCache.set(path, { content: r.content, sha: r.sha })
          return `文件 ${path} 的内容：\n\`\`\`\n${r.content}\n\`\`\``
        }
        if (name === 'propose_edit') {
          const path = String(input?.path ?? '').trim()
          const newContent = String(input?.new_content ?? '')
          const summary = String(input?.summary ?? '').trim()
          if (!path || !newContent) return '缺少 path 或 new_content。'
          if (proposedPaths.size >= MAX_PROPOSED_EDITS && !proposedPaths.has(path)) return `一次最多修改 ${MAX_PROPOSED_EDITS} 个文件。`
          // 拿旧内容 + sha（优先用读过的缓存，没有就现读）
          let cached = shaCache.get(path)
          if (!cached) {
            const r = await readFile(token!, repo, path)
            if ('error' in r) return `无法读取原文件以生成对比：${r.error}`
            cached = { content: r.content, sha: r.sha }
            shaCache.set(path, cached)
          }
          proposedPaths.add(path)
          send(controller, { step: { kind: 'edit', label: `生成修改建议：${path}` } })
          // 推给前端：展示 diff + 等待确认（不写入）
          send(controller, { codeEdit: { path, oldContent: cached.content, newContent, sha: cached.sha, summary } })
          return `已为 ${path} 生成修改建议并展示给用户（等待其点击「确认提交」）。继续处理其他文件或总结你的改动。`
        }
        if (name === 'code_remember') {
          const content = String(input?.content ?? '').trim()
          if (!content) return '内容为空。'
          let ok = false
          if (userId && supabase) {
            try {
              const { error } = await supabase.from('code_memories').insert({ user_id: userId, repo, content })
              ok = !error
            } catch { ok = false }
          }
          send(controller, { step: { kind: 'memory', label: `记住：${content.slice(0, 40)}` } })
          return ok ? '已记住。' : '记忆保存失败（可能未建表）。'
        }
        return '未知工具。'
      }

      try {
        let lastHadToolCalls = false
        let lastTurn: any = null
        for (let round = 0; round < maxRounds; round++) {
          const turn = await runOpenAITurn(url, DEEPSEEK_API_KEY, model, msgs, tools, controller, { thinking })
          totalTokensUsed += turn.totalTokens
          log.info('codeChat', 'Turn finished', { round, finishReason: turn.finishReason, toolCalls: turn.toolCalls.length, contentLen: turn.content.length })
          lastTurn = turn
          lastHadToolCalls = turn.toolCalls.length > 0
          if (turn.failed || !lastHadToolCalls) break
          msgs.push(turn.assistantMessage)
          for (const tc of turn.toolCalls) {
            let input: any = {}
            try { input = JSON.parse(tc.args || '{}') } catch {}
            const result = await execCodeTool(tc.name, input)
            msgs.push({ role: 'tool', tool_call_id: tc.id, content: result })
          }
        }
        // 轮次用尽但还在调工具 → 补一轮纯文本总结
        if (lastHadToolCalls) {
          lastTurn = await runOpenAITurn(url, DEEPSEEK_API_KEY, model, msgs, [], controller, { thinking })
          totalTokensUsed += lastTurn.totalTokens
        }
      } catch (error) {
        send(controller, { error: networkError(error) })
      } finally {
        if (userId && supabase) await addQuotaUsage(supabase, userId, totalTokensUsed, model, thinking, usingBalance)
        done(controller)
      }
    },
  })

  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } })
}
