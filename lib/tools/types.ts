// 工具契约：每个工具自包含一份定义（名字/描述/入参 schema）+ 启用条件 + 执行逻辑。
// route.ts 不认识任何具体工具，只按这份契约遍历、转格式、派发执行。
import type { SupabaseClient } from '@supabase/supabase-js'
import type { SearchMode } from '@/lib/search-mode'

// 执行工具时能拿到的运行环境（用于写当前登录用户自己的数据，受 RLS 隔离）
export type ToolContext = {
  // Browser requests normally pass the RLS client. Durable workers pass the
  // service client and every tool still scopes mutations by the explicit
  // principal below; this keeps tool code reusable without trusting ambient
  // auth state inside a background process.
  supabase: SupabaseClient | null
  userId: string | null
  projectId?: string | null  // 有值 = 当前在项目内，记忆写 project_memories 表
  searchMode?: SearchMode
  latestBeijingDate?: string | null
  signal?: AbortSignal
}

// 工具执行结果：result 回灌给模型；event 可选，推给前端展示（如 memory / search）
export type ToolOutcome = {
  result: string
  event?: object
}

// 与具体协议无关的 JSON Schema（转 Anthropic 时叫 input_schema，转 OpenAI 时叫 parameters）
export type ToolSchema = {
  type: 'object'
  properties: Record<string, unknown>
  required?: string[]
}

// 本次请求的上下文开关，决定哪些工具可用
export type ToolFlags = {
  loggedIn: boolean       // 已登录 → 记忆类工具可用
  searchMode: SearchMode  // 搜索档位：关闭 / 联网 / 深度联网
  memoryEnabled: boolean  // 用户开启记忆总开关 → 记忆类工具可用
  projectId?: string | null  // 有值 = 当前在项目内
}

// 一个工具的完整定义
export type ToolDef = {
  name: string
  description: string
  schema: ToolSchema
  enabled: (flags: ToolFlags) => boolean
  execute: (input: unknown, ctx: ToolContext) => Promise<ToolOutcome>
}
