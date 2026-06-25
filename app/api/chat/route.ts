import { NextRequest } from 'next/server'
import type { Memory } from '@/lib/memory-data'
import { TIER_MAP } from '@/lib/chat-data'
import { buildSystem } from '@/lib/llm/system'
import { send, done, networkError } from '@/lib/llm/stream'
import { chatCompletionsUrl, injectAttachmentsOpenAI } from '@/lib/llm/openai'
import { runAgentLoop, type ExecuteTool } from '@/lib/llm/agent-loop'
import type { Emit, ChatEvent } from '@/lib/llm/events'
import type { RawMsg } from '@/lib/llm/types'
import { buildModelContext } from '@/lib/llm/context'
import { getModelCapability } from '@/lib/llm/models'
import { ensureImageSummaries } from '@/lib/llm/image-context'
import { activeTools, toOpenAITools, execTool, type ToolContext } from '@/lib/tools'
import { log } from '@/lib/logger'
import { validate } from '@/lib/validation'
import { addQuotaUsage } from '@/lib/quota'
import { ocrPageImages } from '@/lib/mimo'
import { resolveAuth, getMemoryEnabled, enforceLimits } from '@/lib/api/guard'
import { latestBeijingDateFromMessages, normalizeSearchMode } from '@/lib/search-mode'

const SAFETY_ROUNDS = 9999

// 深度研究幽灵提示词：前置注入到用户消息，前端不可见
const DEEP_RESEARCH_PREFIX = `Absolute maximum with no shortcuts permitted. You must treat this request as a highest-effort reasoning task. Before giving the final answer, fully understand the user's question, identify the real objective, and avoid answering only the surface wording. Do not rush to produce a response. Reasoning requirements:
1. Decompose the problem completely. Break the task into all necessary subproblems. Identify definitions, assumptions, constraints, hidden conditions, edge cases, and possible interpretations.
2. Search for the root cause. Do not stop at the first plausible explanation. Keep checking whether the current answer only explains a symptom rather than the underlying mechanism.
3. Stress-test every major conclusion. For each important claim, test it against counterexamples, alternative explanations, boundary cases, adversarial cases, and failure modes.
4. Compare multiple paths. If there are multiple possible approaches, evaluate them before choosing. State the final chosen path clearly. Do not pretend uncertainty is resolved when it is not.
5. Avoid shortcuts. Do not skip key steps. Do not rely on vague intuition. Do not compress the solution so much that important logic disappears.
6. Prioritize correctness over speed. For math, logic, code, legal/technical interpretation, factual analysis, research, or strategy problems, accuracy and internal consistency are more important than brevity.
7. Verify the answer before finalizing. Check whether the final answer: directly answers the user's actual question; satisfies all stated constraints; avoids unsupported claims; handles important exceptions; does not contradict earlier reasoning; is useful in practice.
8. Handle uncertainty explicitly. If information is missing, state what can be concluded, what cannot be concluded, and what assumption is being used. Do not fabricate certainty.
9. Output format. Do not expose raw private chain-of-thought. Instead, provide a clear, structured, checkable explanation with the necessary reasoning steps, final conclusion, and any caveats.
10. If the task is complex, use this structure: Core conclusion → Key reasoning → Failure checks / edge cases → Final answer.

（用户仅打开了深度研究模式，这份提示词用户看不到，请不要输出它。并且严格地使用。Artifact 输出。无任何字数、Token 限制。依旧保持人味，不要像一个机器。）

---
`

// 扫描件 PDF：前端已把每页渲染成图片放进 pageImages，这里用小米 MiMo-Omni 视觉模型 OCR 成文字，
// 替换进 text；DeepSeek 随后只看到精确文字。彻底替代之前那条走不通的 DeepSeek /v1/files 上传。
async function ocrScannedPdfs(attachments: any[]): Promise<any[]> {
  if (!attachments?.length) return attachments ?? []
  return Promise.all(attachments.map(async (f) => {
    if (!Array.isArray(f.pageImages) || !f.pageImages.length) return f
    const text = await ocrPageImages(f.pageImages)
    log.info('ocrPdf', 'Scanned PDF OCR done', { name: f.name, pages: f.pageImages.length, textLen: text.length })
    return { ...f, text: text || '（扫描件识别失败，请重试或换一份更清晰的文件）', pageImages: undefined }
  }))
}

export async function POST(req: NextRequest) {
  let body: any = {}
  try {
    body = await req.json()
  } catch (e) {
    log.error('chat', 'Invalid JSON in request body', e)
    return new Response(JSON.stringify({ error: '请求体格式错误' }), { status: 400, headers: { 'Content-Type': 'application/json' } })
  }

  const { tier = '绝句', messages, memories, attachments, searchMode, webSearch, deepWebSearch, deepResearch, project } = body

  try {
    validate.array(messages, 'messages', { minLength: 1 })
  } catch (e) {
    log.warn('chat', 'Validation error', e)
    return new Response(JSON.stringify({ error: (e as Error).message }), { status: 400, headers: { 'Content-Type': 'application/json' } })
  }

  const tierCfg = TIER_MAP[tier as keyof typeof TIER_MAP] ?? TIER_MAP['绝句']
  // 深度研究模式：强制使用最强模型 + 开启思考链
  const model = deepResearch ? 'deepseek-v4-pro' : tierCfg.model
  const thinking = deepResearch ? true : tierCfg.thinking
  const capability = getModelCapability(model)
  const apiKey = process.env[capability.provider.apiKeyEnv] ?? ''
  if (!apiKey) {
    log.error('chat', `${capability.provider.apiKeyEnv} not configured`)
    return new Response(JSON.stringify({ error: `服务未配置（${capability.provider.apiKeyEnv} 未设置）` }), { status: 500 })
  }

  // 鉴权 + 记忆开关 + 限流/额度闸门（统一收敛到 guard 层）
  const auth = await resolveAuth()
  const { supabase, userId } = auth
  const memoryEnabled = await getMemoryEnabled(auth)
  const gate = await enforceLimits(auth)
  if (gate.response) return gate.response
  const usingBalance = gate.usingBalance

  const effectiveSearchMode =
    searchMode === 'web' || searchMode === 'deep'
      ? searchMode
      : normalizeSearchMode(webSearch, deepWebSearch)
  const latestBeijingDate = latestBeijingDateFromMessages(messages as RawMsg[])
  const flags = { loggedIn: !!userId, searchMode: effectiveSearchMode, memoryEnabled, projectId: project?.id ?? null }
  const tools = activeTools(flags)
  const ctx: ToolContext = { supabase, userId, projectId: project?.id ?? null, searchMode: effectiveSearchMode, latestBeijingDate }

  // 关闭记忆时：既不挂记忆工具（上面已过滤），也不注入已存的记忆
  const effectiveMemories = memoryEnabled ? (memories as Memory[] | undefined) : undefined
  const url = chatCompletionsUrl(capability.provider.baseUrl)
  const SYSTEM = buildSystem(effectiveMemories, { searchMode: effectiveSearchMode, latestBeijingDate, memoryEnabled, project })
  const openaiTools = toOpenAITools(tools)

  const stream = new ReadableStream({
    async start(controller) {
      let clientConnected = true
      const safeSend = (event: ChatEvent | { heartbeat: true }) => {
        if (!clientConnected) return
        try { send(controller, event) } catch { clientConnected = false }
      }
      const emit: Emit = (e) => safeSend(e)
      let totalTokensUsed = 0
      const heartbeat = setInterval(() => safeSend({ heartbeat: true }), 8_000)

      // 工具执行：派发到注册表，把工具产生的前端事件（memory / search）实时 emit 出去
      const executeTool: ExecuteTool = async (name, input) => {
        const { result, event } = await execTool(tools, name, input, ctx)
        if (event) emit(event as ChatEvent)
        return result
      }

      try {
        const preparedMessages = await ensureImageSummaries(messages as RawMsg[], { supabase, userId, emit })
        const msgs: any[] = [{ role: 'system', content: SYSTEM }, ...buildModelContext(preparedMessages, capability)]

        // 深度研究：幽灵提示前置注入到最后一条用户消息，前端不可见
        if (deepResearch) {
          for (let i = msgs.length - 1; i >= 0; i--) {
            if (msgs[i].role === 'user') {
              const m = msgs[i]
              if (typeof m.content === 'string') {
                m.content = DEEP_RESEARCH_PREFIX + m.content
              } else if (Array.isArray(m.content)) {
                const textItem = m.content.find((c: any) => c.type === 'text')
                if (textItem) textItem.text = DEEP_RESEARCH_PREFIX + textItem.text
              }
              break
            }
          }
        }

        // 扫描件 OCR 较慢，先给个状态提示，避免用户干等 + 保持连接活跃
        const hasScanned = Array.isArray(attachments) && attachments.some((a: any) => a?.pageImages?.length)
        if (hasScanned) emit({ thinking: '正在识别扫描件内容，请稍候……' })
        const processedAttachments = await ocrScannedPdfs(attachments)
        await injectAttachmentsOpenAI(msgs, processedAttachments)

        const { totalTokens } = await runAgentLoop({
          url, apiKey, model, adapter: capability.provider.adapter, thinking,
          messages: msgs, tools: openaiTools, emit, executeTool,
          maxRounds: SAFETY_ROUNDS,
          leakedRetry: true,
          autoContinue: {},
          onTurn: ({ phase, round, turn }) => {
            log.info('chat', `Turn ${phase}`, { round, finishReason: turn.finishReason, leaked: turn.leaked, toolCalls: turn.toolCalls.length, contentLen: turn.content.length, truncated: turn.truncated })
          },
        })
        totalTokensUsed += totalTokens
      } catch (error) {
        emit({ error: networkError(error) })
      } finally {
        clearInterval(heartbeat)
        // 写额度必须在关闭响应前完成，确保同步性
        if (userId && supabase) {
          await addQuotaUsage(supabase, userId, totalTokensUsed, model, thinking, usingBalance)
        }
        done(controller)
      }
    },
  })

  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
  })
}
