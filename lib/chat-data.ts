export type Protocol = "anthropic" | "openai" | "gemini"

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
}

export const PROTOCOL_DEFAULTS: Record<Protocol, { baseUrl: string; model: string }> = {
  anthropic: { baseUrl: "https://api.anthropic.com", model: "claude-sonnet-4-6" },
  openai: { baseUrl: "https://api.deepseek.com", model: "deepseek-chat" },
  gemini: { baseUrl: "https://generativelanguage.googleapis.com", model: "gemini-2.0-flash" },
}

export type Message = {
  id: string
  role: "user" | "assistant"
  content: string
  time: string
  isError?: boolean
  thinking?: string   // 思考链文本
  images?: string[]   // base64 data URLs
  memoryNotes?: string[]   // 本次回复中模型对记忆做的操作（仅当次显示）
  files?: string[]   // 附件文件名（只显示成卡片，全文由后端注入给模型）
  searchNotes?: { query: string; results: { title: string; url: string }[] }[]   // 联网搜索来源
  artifactHtml?: string | null        // <artifact>...</artifact> 内的完整 HTML
  artifactPartialHtml?: string | null // 正在流式生成的部分 HTML（用于实时预览）
  artifactLoading?: boolean           // artifact 正在流式生成中
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
