import { NextRequest } from 'next/server'
import { cookies } from 'next/headers'
import { TIER_MAP } from '@/lib/chat-data'
import { send, done, networkError } from '@/lib/llm/stream'
import { toOpenAI, chatCompletionsUrl } from '@/lib/llm/openai'
import { runAgentLoop, type ExecuteTool } from '@/lib/llm/agent-loop'
import type { Emit } from '@/lib/llm/events'
import { listTree, readFile, repoMeta } from '@/lib/github'
import { log } from '@/lib/logger'
import { validate } from '@/lib/validation'
import { addQuotaUsage } from '@/lib/quota'
import { resolveAuth, enforceLimits } from '@/lib/api/guard'

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY ?? ''
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com'
const TAVILY_API_KEY = process.env.TAVILY_API_KEY ?? ''

const ROUNDS_NORMAL = 10
const ROUNDS_GOAL = 24
const MAX_FILE_READS = 30

function buildCodeSystem(repo: string | null, defaultBranch: string | null, login: string, memories: string[], goal: boolean): string {
  let s = `你是「小克 · 代码」，一个能真正操作用户 GitHub 账号的编程助手，运行在网页应用的 Code 板块里。当前用户的 GitHub 用户名是 ${login}。

你能像 Claude Code / GPT 的仓库助手那样真正动手做事，工具如下：
- list_files / read_file：浏览、阅读仓库里的真实文件（修改前先读，了解上下文）。
- create_repo：新建一个仓库。用户想从零做新项目（比如「做个番茄钟」）时，先建仓库。仓库名用英文小写连字符（如 pomodoro-timer）。
- write_files：写入一个或多个文件（新建或覆盖）。从零搭项目就一次把所有文件都写出来（如 index.html / style.css / script.js）。传完整文件内容。
- delete_files：删除文件。
- enable_pages：对纯静态/前端项目开启 GitHub Pages，让它有一个能直接打开的网址（部署上线）。
- code_remember：记住关于本仓库的长期事实（架构、技术栈、易错点、用户偏好）。只属于本仓库。

工作方式（重要）：
1. 用户用大白话描述要做什么，往往不懂代码、说不出文件名。你要自己判断、自己动手。
2. 改现有项目：先 list_files / read_file 定位，再 write_files 给出完整新内容。
3. 做新项目：create_repo → write_files 写全部文件 →（若是纯前端）enable_pages 上线。
4. 你调用 create_repo / write_files / delete_files / enable_pages 只是把动作【加入待执行计划】，会先展示给用户；用户确认后（或在自动模式下）才真正提交并直接推送上线。所以你尽管一次把该做的都规划好。
5. 做完用中文简明说明你做了什么、（若上线了）网址是什么。像个干练的工程师，别啰嗦，不要用 emoji。

注意：你无法真正运行/测试代码，是在"盲写"，所以代码要尽量正确、自包含。纯前端项目优先（HTML/CSS/JS 单页应用最稳，可直接 Pages 上线）。`

  if (repo) s += `\n\n用户当前选中的仓库：${repo}（默认分支 ${defaultBranch}）。`
  else s += `\n\n用户还没有选择仓库。如果他要做新项目，用 create_repo 新建；如果他要改某个现有项目，请提示他先在上方选择仓库。`

  if (memories.length) s += `\n\n关于本仓库你已经记住的事（${memories.length} 条）：\n${memories.map(m => `- ${m}`).join('\n')}`
  if (goal) s += `\n\n【目标模式】用户设定了一个目标，请自主连续工作、尽可能一次推进到位，把需要的仓库、文件、上线都规划好，不要中途停下问无关紧要的细节。`
  return s
}

export async function POST(req: NextRequest) {
  let body: any = {}
  try { body = await req.json() } catch { return new Response(JSON.stringify({ error: '请求体格式错误' }), { status: 400 }) }

  const { repo = null, tier = '正构', goal = false, messages } = body
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

  const tierCfg = TIER_MAP[tier as keyof typeof TIER_MAP] ?? TIER_MAP['正构']
  const model = tierCfg.model
  const thinking = tierCfg.thinking

  // 鉴权 + 限流/额度闸门（与 /api/chat 共用 guard 层）
  const auth = await resolveAuth()
  const { supabase, userId } = auth
  const gate = await enforceLimits(auth)
  if (gate.response) return gate.response
  const usingBalance = gate.usingBalance

  // 选了仓库才校验 + 取默认分支；没选（新建项目模式）则跳过
  let defaultBranch: string | null = null
  if (repo) {
    const meta = await repoMeta(token, repo)
    if (!meta) return new Response(JSON.stringify({ error: '仓库访问失败，请重新连接 GitHub' }), { status: 502 })
    defaultBranch = meta.defaultBranch
  }

  let memContents: string[] = []
  if (repo && userId && supabase) {
    try {
      const { data } = await supabase.from('code_memories').select('content').eq('user_id', userId).eq('repo', repo).order('created_at')
      memContents = (data ?? []).map((r: any) => r.content as string)
    } catch { /* 表未建时静默 */ }
  }

  const SYSTEM = buildCodeSystem(repo, defaultBranch, login, memContents, !!goal)
  const url = chatCompletionsUrl(DEEPSEEK_BASE_URL)

  const tools = [
    { type: 'function', function: { name: 'list_files', description: '列出当前仓库完整文件路径列表。', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'read_file', description: '读取当前仓库某文件的真实完整内容。修改前必须先读。', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
    { type: 'function', function: { name: 'create_repo', description: '新建一个 GitHub 仓库（做新项目时用）。', parameters: { type: 'object', properties: { name: { type: 'string', description: '英文小写连字符，如 pomodoro-timer' }, description: { type: 'string' }, private: { type: 'boolean', description: '是否私有，默认 false' } }, required: ['name'] } } },
    { type: 'function', function: { name: 'write_files', description: '写入一个或多个文件（新建或覆盖），传完整内容。从零搭项目就一次写全部文件。', parameters: { type: 'object', properties: { files: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string', description: '完整文件内容，不省略' } }, required: ['path', 'content'] } } }, required: ['files'] } } },
    { type: 'function', function: { name: 'delete_files', description: '删除一个或多个文件。', parameters: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' } } }, required: ['paths'] } } },
    { type: 'function', function: { name: 'enable_pages', description: '对纯静态/前端项目开启 GitHub Pages，让项目有可访问网址（上线）。', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'code_remember', description: '记住一条关于本仓库的长期事实。', parameters: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'] } } },
    { type: 'function', function: { name: 'search', description: '网络搜索（文档、API、技术资料等）。需要查阅外部资源时用。', parameters: { type: 'object', properties: { query: { type: 'string', description: '搜索关键词或短语' } }, required: ['query'] } } },
  ]

  const maxRounds = goal ? ROUNDS_GOAL : ROUNDS_NORMAL

  const stream = new ReadableStream({
    async start(controller) {
      const emit: Emit = (e) => send(controller, e)
      let totalTokensUsed = 0
      let fileReads = 0
      const shaCache = new Map<string, string>()  // path → 读过的旧内容（给前端做 diff）
      const msgs: any[] = [{ role: 'system', content: SYSTEM }, ...toOpenAI(messages)]

      const executeTool: ExecuteTool = async (name, input) => {
        if (name === 'list_files') {
          if (!repo) return '尚未选择仓库。'
          emit({ step: { kind: 'list', label: '浏览仓库文件结构' } })
          const { paths, truncated } = await listTree(token!, repo, defaultBranch!)
          if (!paths.length) return '仓库为空或无法获取文件列表。'
          return `仓库共 ${paths.length} 个文件${truncated ? '（已截断）' : ''}：\n${paths.join('\n')}`
        }
        if (name === 'read_file') {
          if (!repo) return '尚未选择仓库。'
          const path = String(input?.path ?? '').trim()
          if (!path) return '缺少 path。'
          if (fileReads >= MAX_FILE_READS) return '读取文件数已达上限，请基于已读内容继续。'
          fileReads++
          emit({ step: { kind: 'read', label: `读取 ${path}` } })
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
          return `已加入计划：新建仓库 ${login}/${name2}。继续写入文件。`
        }
        if (name === 'write_files') {
          const files = Array.isArray(input?.files) ? input.files : []
          if (!files.length) return '没有要写的文件。'
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
          }
          return `已加入计划：写入 ${files.length} 个文件（等待用户确认/自动执行）。`
        }
        if (name === 'delete_files') {
          const paths = Array.isArray(input?.paths) ? input.paths : []
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
        return '未知工具。'
      }

      try {
        const { totalTokens } = await runAgentLoop({
          url, apiKey: DEEPSEEK_API_KEY, model, thinking,
          messages: msgs, tools, emit, executeTool,
          maxRounds,
          onTurn: ({ phase, round, turn }) => {
            if (phase === 'round') log.info('codeChat', 'Turn finished', { round, finishReason: turn.finishReason, toolCalls: turn.toolCalls.length, contentLen: turn.content.length })
          },
        })
        totalTokensUsed += totalTokens
      } catch (error) {
        emit({ error: networkError(error) })
      } finally {
        if (userId && supabase) await addQuotaUsage(supabase, userId, totalTokensUsed, model, thinking, usingBalance)
        done(controller)
      }
    },
  })

  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } })
}
