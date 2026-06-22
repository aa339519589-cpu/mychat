export type Tier = "绝句" | "正构" | "鸿篇"

export type TierConfig = { id: Tier; label: string; desc: string; model: string; thinking: boolean }

export const TIERS: TierConfig[] = [
  { id: "绝句", label: "绝句", desc: "迅捷",  model: "deepseek-chat",     thinking: false },
  { id: "正构", label: "正构", desc: "思考",  model: "deepseek-chat",     thinking: true  },
  { id: "鸿篇", label: "鸿篇", desc: "深推",  model: "deepseek-reasoner", thinking: true  },
]

export const TIER_MAP: Record<Tier, TierConfig> = Object.fromEntries(TIERS.map(t => [t.id, t])) as Record<Tier, TierConfig>

export type Message = {
  id: string
  role: "user" | "assistant"
  content: string
  time: string
  isError?: boolean
  thinking?: string
  images?: string[]
  memoryNotes?: string[]
  files?: string[]
  searchNotes?: { query: string; results: { title: string; url: string }[] }[]
  sheetMusicNotes?: { type: string; svg: string; status: "rendering" | "done" }[]
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
