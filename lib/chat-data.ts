export type Tier = "绝句" | "正构" | "鸿篇"

export type TierConfig = { id: Tier; label: string; desc: string; model: string; thinking: boolean }

export const TIERS: TierConfig[] = [
  { id: "绝句", label: "绝句", desc: "迅捷",  model: "deepseek-v4-flash", thinking: false },
  { id: "正构", label: "正构", desc: "思考",  model: "deepseek-v4-flash", thinking: true  },
  { id: "鸿篇", label: "鸿篇", desc: "深推",  model: "deepseek-v4-pro",   thinking: true  },
]

export const TIER_MAP: Record<Tier, TierConfig> = Object.fromEntries(TIERS.map(t => [t.id, t])) as Record<Tier, TierConfig>

export type Message = {
  id: string
  role: "user" | "assistant"
  content: string
  time: string
  ts?: string   // ISO 8601 发送时间（系统元数据，传给模型用于时间感知；缺失视为未知时间）
  isError?: boolean
  thinking?: string
  images?: string[]
  memoryNotes?: string[]
  files?: string[]
  searchNotes?: { query: string; results: { title: string; url: string }[] }[]
}

export type Conversation = {
  id: string
  title: string
  excerpt: string
  date: string
  messages: Message[]
  projectId?: string | null
  starred?: boolean
  pinned?: boolean
  draft?: boolean   // 本地草稿：尚未发送首条消息、未写入数据库；不进列表、不可删
  msgCount?: number // 仅加载时带回的消息条数；用于隐藏历史遗留的空会话
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
