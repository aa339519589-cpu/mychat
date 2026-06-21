export type Protocol = "anthropic" | "openai" | "gemini" | "claude-web"

export type Endpoint = {
  id: string
  name: string       // 用户自定义名称，如"我的DeepSeek"
  protocol: Protocol
  baseUrl: string    // 如 https://api.deepseek.com
  apiKey: string
  model: string      // 如 deepseek-chat
}

export const PROTOCOL_LABELS: Record<Protocol, string> = {
  anthropic: "Anthropic 协议",
  openai: "DeepSeek / OpenAI 兼容",
  gemini: "Gemini 协议",
  "claude-web": "Claude 网页订阅",
}

export const PROTOCOL_DEFAULTS: Record<Protocol, { baseUrl: string; model: string }> = {
  anthropic: { baseUrl: "https://api.anthropic.com", model: "claude-sonnet-4-6" },
  openai: { baseUrl: "https://api.deepseek.com", model: "deepseek-chat" },
  gemini: { baseUrl: "https://generativelanguage.googleapis.com", model: "gemini-2.0-flash" },
  "claude-web": { baseUrl: "https://claude.ai", model: "claude-opus-4-5-20251101" },
}

export type Message = {
  id: string
  role: "user" | "assistant"
  content: string
  time: string
  isError?: boolean
  thinking?: string   // 思考链文本
}

export type Conversation = {
  id: string
  title: string
  excerpt: string
  date: string
  messages: Message[]
}

export const CONVERSATIONS: Conversation[] = [
  {
    id: "c-default",
    title: "未命名的篇章",
    excerpt: "一页尚待书写的空白……",
    date: "今日",
    messages: [],
  },
]
