import type { GeneratedMedia } from "@/lib/generated-media"

export type Tier = "绝句" | "正构" | "鸿篇" | "观照"

export type TierConfig = { id: Tier; label: string; desc: string; model: string; thinking: boolean }

// id 是内部 value（传后端、存 localStorage，绝不改）；label 是 UI 显示名。
export const TIERS: TierConfig[] = [
  { id: "绝句", label: "快速", desc: "迅捷",  model: "deepseek-v4-flash", thinking: false },
  { id: "正构", label: "均衡", desc: "稳健",  model: "deepseek-v4-flash", thinking: true  },
  { id: "鸿篇", label: "深度", desc: "深推",  model: "platform-deep", thinking: true  },
  // 观照只作为图片解析器，不在前端模型列表展示。
  { id: "观照", label: "视觉", desc: "V2.5",  model: "mimo-v2.5",         thinking: false },
]

export const MODEL_SHEET_TIERS: Tier[] = ["鸿篇", "正构", "绝句"]

export const CODE_TIERS = TIERS.filter(t => t.id !== "观照")

export const TIER_MAP: Record<Tier, TierConfig> = Object.fromEntries(TIERS.map(t => [t.id, t])) as Record<Tier, TierConfig>

export type Message = {
  id: string
  role: "user" | "assistant"
  content: string
  time: string
  ts?: string   // ISO 8601 发送时间（系统元数据，传给模型用于时间感知；缺失视为未知时间）
  isError?: boolean
  outputWarning?: string
  thinking?: string
  images?: string[]
  imageSummary?: string
  media?: GeneratedMedia[]
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
