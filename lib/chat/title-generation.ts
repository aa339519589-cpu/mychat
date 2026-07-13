import { RequestError } from '@/lib/api/request'
import { runAgentLoop, type AgentLoopOpts } from '@/lib/llm/agent-loop'
import { chatCompletionsUrl } from '@/lib/llm/openai'
import type { ChatModelSelection } from './model-selection'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_SOURCE_CHARS = 2_000
const MAX_TITLE_CHARS = 20

export type TitleGenerationRequest = {
  conversationId: string
  userText: string
  assistantText: string
  endpointId?: string
}

export function validateTitleGenerationRequest(value: unknown): TitleGenerationRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RequestError(400, '请求体格式错误')
  }
  const body = value as Record<string, unknown>
  if (typeof body.conversationId !== 'string' || !UUID.test(body.conversationId)) {
    throw new RequestError(400, 'conversationId 无效')
  }
  for (const field of ['userText', 'assistantText'] as const) {
    if (typeof body[field] !== 'string' || body[field].length === 0) {
      throw new RequestError(400, `${field} 无效`)
    }
    if (body[field].length > MAX_SOURCE_CHARS) {
      throw new RequestError(413, `${field} 过长`)
    }
  }
  if (body.endpointId !== undefined && (typeof body.endpointId !== 'string' || !UUID.test(body.endpointId))) {
    throw new RequestError(400, 'endpointId 无效')
  }
  return body as TitleGenerationRequest
}

export function normalizeGeneratedTitle(value: string): string {
  return value
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .replace(/^["'“”‘’「『]|["'“”‘’」』。！？!?，,；;：:]+$/g, '')
    .trim()
    .slice(0, MAX_TITLE_CHARS)
}

type TitleDependencies = {
  runAgentLoop: (options: AgentLoopOpts) => Promise<{ totalTokens: number }>
}

export async function generateTitleText(options: {
  request: TitleGenerationRequest
  selection: ChatModelSelection
  signal: AbortSignal
}, dependencies: TitleDependencies = { runAgentLoop }): Promise<{ title: string; totalTokens: number }> {
  if (options.selection.outputKind !== 'chat') {
    throw new RequestError(400, '标题生成只支持聊天模型')
  }
  let output = ''
  const { totalTokens } = await dependencies.runAgentLoop({
    url: chatCompletionsUrl(options.selection.capability.provider.baseUrl),
    apiKey: options.selection.apiKey,
    model: options.selection.model,
    adapter: options.selection.capability.provider.adapter,
    thinking: false,
    messages: [
      { role: 'system', content: '你只负责生成简短对话标题。不得调用工具，只输出标题本身，不要引号、解释或标点。' },
      {
        role: 'user',
        content: `给下面对话生成一个10个汉字以内的标题：\n用户：${options.request.userText}\nAI：${options.request.assistantText}`,
      },
    ],
    tools: [],
    emit: event => {
      if ('text' in event) output += event.text
    },
    executeTool: async () => { throw new Error('Title generation does not allow tools') },
    maxRounds: 1,
    turnOptions: {
      signal: options.signal,
      timeoutMs: 30_000,
      authType: options.selection.authType,
      maxOutputTokens: 64,
    },
  })
  const title = normalizeGeneratedTitle(output)
  if (!title) throw new Error('模型未返回有效标题')
  return { title, totalTokens }
}
