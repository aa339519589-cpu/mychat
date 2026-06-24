import { NextRequest } from 'next/server'
import { cookies } from 'next/headers'
import { TIER_MAP } from '@/lib/chat-data'
import { send, done, networkError } from '@/lib/llm/stream'
import { toOpenAI, chatCompletionsUrl } from '@/lib/llm/openai'
import { runAgentLoop, type ExecuteTool } from '@/lib/llm/agent-loop'
import type { Emit } from '@/lib/llm/events'
import { listTree, readFile, repoMeta, ghHeaders } from '@/lib/github'
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
- edit_file：精确修改文件中的一段内容。传入 old_string（原文中唯一的一段文字）和 new_string（替换成什么），AI 自动找到并替换。比 write_files 更精准，适合局部改动。
- delete_files：删除文件。
- execute：在沙箱中运行命令进行语法校验或快速验证（如 node --check 文件.js、node -e、python3 -c、cat、grep、ls 等）。改完代码后建议先跑一次校验。需要完整构建/测试时可以用 npm run build / npm test（会尝试触发 GitHub Actions）。
- enable_pages：对纯静态/前端项目开启 GitHub Pages，让它有一个能直接打开的网址（部署上线）。
- code_remember：记住关于本仓库的长期事实（架构、技术栈、易错点、用户偏好）。只属于本仓库。
- search：网络搜索（文档、API、技术资料等）。

工作方式（重要）：
1. 用户用大白话描述要做什么，往往不懂代码、说不出文件名。你要自己判断、自己动手。
2. 改现有项目：先 list_files / read_file 定位，再用 edit_file（局部改动）或 write_files（新建/覆盖）给出改动。
3. 做新项目：create_repo → write_files 写全部文件 →（若是纯前端）enable_pages 上线。
4. 改完代码后用 execute 跑一次语法校验（如 node --check）确认代码正确性。
5. 你调用 create_repo / write_files / edit_file / delete_files / enable_pages 只是把动作【加入待执行计划】，会先展示给用户；用户确认后（或在自动模式下）才真正提交并直接推送上线。所以你尽管一次把该做的都规划好。
6. 做完用中文简明说明你做了什么、（若上线了）网址是什么。像个干练的工程师，别啰嗦，不要用 emoji。

注意：edit_file 的 old_string 必须与原文完全一致（区分大小写），且内容在文件中只能出现一次。如果不确定，先用 read_file 确认准确内容。`

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

  const tierCfg = tier === '观照' ? TIER_MAP['正构'] : (TIER_MAP[tier as keyof typeof TIER_MAP] ?? TIER_MAP['正构'])
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
  // origin 变量已移除（沙箱改为直接调用）

  const tools = [
    { type: 'function', function: { name: 'list_files', description: '列出当前仓库完整文件路径列表。', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'read_file', description: '读取当前仓库某文件的真实完整内容。修改前必须先读。', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
    { type: 'function', function: { name: 'create_repo', description: '新建一个 GitHub 仓库（做新项目时用）。', parameters: { type: 'object', properties: { name: { type: 'string', description: '英文小写连字符，如 pomodoro-timer' }, description: { type: 'string' }, private: { type: 'boolean', description: '是否私有，默认 false' } }, required: ['name'] } } },
    { type: 'function', function: { name: 'write_files', description: '写入一个或多个文件（新建或覆盖），传完整内容。从零搭项目就一次写全部文件。', parameters: { type: 'object', properties: { files: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string', description: '完整文件内容，不省略' } }, required: ['path', 'content'] } } }, required: ['files'] } } },
    { type: 'function', function: { name: 'edit_file', description: '精确修改文件中的一段内容。用 old_string 定位原文（必须唯一），替换成 new_string。适用于局部改动。', parameters: { type: 'object', properties: { path: { type: 'string', description: '文件路径' }, old_string: { type: 'string', description: '原文中要替换的字符串（区分大小写，必须唯一）' }, new_string: { type: 'string', description: '替换成的新内容' } }, required: ['path', 'old_string', 'new_string'] } } },
    { type: 'function', function: { name: 'delete_files', description: '删除一个或多个文件。', parameters: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' } } }, required: ['paths'] } } },
    { type: 'function', function: { name: 'execute', description: '在沙箱中执行命令进行快速校验（node --check、node -e、python3 -c、grep、cat 等简单命令）。也可以触发 GitHub Actions 跑构建/测试。改完代码后建议先跑语法校验。', parameters: { type: 'object', properties: { command: { type: 'string', description: '要执行的命令' } }, required: ['command'] } } },
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
        if (name === 'edit_file') {
          if (!repo) return '尚未选择仓库。'
          const path = String(input?.path ?? '').trim()
          const oldString = String(input?.old_string ?? '')
          const newString = String(input?.new_string ?? '')
          if (!path || !oldString) return '缺少 path 或 old_string。'
          emit({ step: { kind: 'edit', label: `编辑 ${path}` } })
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

          // 判断是否可能是重任务（构建/测试类）
          const heavyPatterns = ['npm run build', 'npm test', 'npx tsc', 'npm run typecheck', 'npm run ci', 'make', 'npm install']
          const isHeavy = heavyPatterns.some(p => command.startsWith(p))

          if (isHeavy && repo && defaultBranch) {
            // 试试 GitHub Actions dispatch
            const treeRes = await fetch(`https://api.github.com/repos/${repo}/git/trees/${defaultBranch}?recursive=1`, {
              headers: ghHeaders(token!)
            }).catch(() => null)
            if (treeRes?.ok) {
              const tree = await treeRes.json()
              const workflows = (tree.tree as any[])?.filter((item: any) =>
                item.path?.startsWith('.github/workflows/') && item.type === 'blob'
              ) ?? []
              if (workflows.length > 0) {
                const workflowPath = workflows[0].path
                const dispatchRes = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/${encodeURIComponent(workflowPath)}/dispatches`, {
                  method: 'POST',
                  headers: ghHeaders(token!, true),
                  body: JSON.stringify({ ref: defaultBranch, inputs: { command } }),
                }).catch(() => null)
                if (dispatchRes?.ok || dispatchRes?.status === 204) {
                  // 轮询等结果（最多 60 秒）
                  for (let i = 0; i < 30; i++) {
                    await new Promise(r => setTimeout(r, 2000))
                    const runsRes = await fetch(`https://api.github.com/repos/${repo}/actions/runs?branch=${defaultBranch}&per_page=1&event=workflow_dispatch`, {
                      headers: ghHeaders(token!)
                    }).catch(() => null)
                    if (!runsRes?.ok) continue
                    const runs = await runsRes.json()
                    const run = (runs.workflow_runs as any[])?.[0]
                    if (!run || run.status === 'queued' || run.status === 'in_progress') continue
                    const conclusion = run.conclusion ?? 'unknown'
                    const htmlUrl = run.html_url ?? ''
                    const logsRes = await fetch(`https://api.github.com/repos/${repo}/actions/runs/${run.id}/logs`, {
                      headers: ghHeaders(token!)
                    }).catch(() => null)
                    let logs = ''
                    if (logsRes?.ok) {
                      const text = await logsRes.text()
                      logs = text.slice(0, 5000)
                    }
                    return `GitHub Actions 运行完成：${conclusion}\n查看详情：${htmlUrl}\n\n${logs}`
                  }
                  return `已触发 GitHub Actions，但未在 60 秒内完成。请手动查看结果：https://github.com/${repo}/actions`
                }
              }
            }
            // 没有 workflow 或 dispatch 失败，走沙箱
          }

          // 走沙箱（直接调用，不走 HTTP）
          try {
            const result = runInSandbox(command)
            let out = ''
            if (result.stdout) out += `标准输出：\n${result.stdout}\n`
            if (result.stderr) out += `标准错误：\n${result.stderr}\n`
            if (result.error) out += `错误：${result.error}\n`
            if (result.exitCode && result.exitCode !== 0) out += `退出码：${result.exitCode}`
            if (!out) out = '执行完成（无输出）'
            return out
          } catch (err: any) {
            return `沙箱执行异常：${err?.message ?? '未知错误'}`
          }
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
