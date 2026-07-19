import type { SupabaseServer } from "@/lib/api/guard"
import { chatCompletionsUrl } from "./openai"
import { getModelCapability } from "./models"
import { runTurn } from "./turn"
import type { RawMsg } from "./types"
import { log } from "@/lib/logger"

const RECENT_CONTEXT_MESSAGES = 16
const SUMMARY_TRIGGER_MESSAGES = 16
const SUMMARY_MODEL = "deepseek-v4-flash"
const SUMMARY_TARGET_CHARS = 4000

type MessageRow = { id: string; role: "user" | "assistant"; content: string | null; images?: unknown }
type SummaryState = { summary: string; marker: string | null; staleWithoutMarker: boolean }

function emptyState(): SummaryState {
  return { summary: "", marker: null, staleWithoutMarker: false }
}

async function resolveConversationId(
  supabase: SupabaseServer | null,
  userId: string | null,
  explicitId: unknown,
  messages: RawMsg[],
): Promise<string | null> {
  if (typeof explicitId === "string" && explicitId) return explicitId
  if (!supabase || !userId) return null
  const ids = messages.slice().reverse()
    .map(message => message.id)
    .filter((id): id is string => typeof id === "string" && !!id)
    .slice(0, 6)
  const rows = await Promise.all(ids.map(id =>
    supabase.from("messages").select("conversation_id").eq("id", id).eq("user_id", userId).maybeSingle()
  ))
  for (const { data } of rows) {
    if (typeof data?.conversation_id === "string") return data.conversation_id
  }
  return null
}

async function readState(supabase: SupabaseServer | null, userId: string | null, conversationId: string | null): Promise<SummaryState> {
  if (!supabase || !userId || !conversationId) return emptyState()
  const { data, error } = await supabase.from("conversations")
    .select("context_summary, summary_until_message_id")
    .eq("id", conversationId).eq("user_id", userId).maybeSingle()
  if (error || !data) return emptyState()
  const summary = typeof data.context_summary === "string" ? data.context_summary.trim() : ""
  const marker = typeof data.summary_until_message_id === "string" ? data.summary_until_message_id : null
  return { summary: marker ? summary : "", marker, staleWithoutMarker: !!summary && !marker }
}

function shouldCompact(messages: RawMsg[], state: SummaryState): boolean {
  if (state.staleWithoutMarker) return true
  const ids = messages.map(message => message.id).filter((id): id is string => typeof id === "string" && !!id)
  if (state.marker && ids.length && !ids.includes(state.marker)) return true
  const coveredIndex = state.marker ? ids.indexOf(state.marker) : -1
  return Math.max(0, messages.length - RECENT_CONTEXT_MESSAGES - coveredIndex - 1) >= SUMMARY_TRIGGER_MESSAGES
}

function imageSummary(images: unknown): string {
  if (!images || Array.isArray(images)) return ""
  const summary = (images as { image_summary?: unknown }).image_summary
  return typeof summary === "string" ? summary.trim() : ""
}

function summaryPrompt(oldSummary: string, rows: MessageRow[], startIndex: number): string {
  const text = rows.map((row, index) => {
    const parts = [(row.content ?? "").trim(), imageSummary(row.images) ? `图片摘要：${imageSummary(row.images)}` : ""].filter(Boolean)
    return `【第 ${startIndex + index + 1} 条｜${row.role === "user" ? "用户" : "模型"}｜id:${row.id}】\n${parts.join("\n") || "（空内容）"}`
  }).join("\n\n")
  return `你是 MyChat 的当前 conversation 上下文压缩器。\n\n把旧摘要和这批刚变旧的消息合并压缩成新的摘要。只输出摘要正文。越旧越粗，越新越细。只保留影响后续连贯性的方案、参数、用户纠正、代码决策、数学状态和重要上下文。删除寒暄、重复和临时吐槽。目标控制在 ${SUMMARY_TARGET_CHARS} 字以内。\n\n【旧摘要】\n${oldSummary.trim() || "（无）"}\n\n【需要折叠的旧消息】\n${text}`
}

async function summarize(oldSummary: string, rows: MessageRow[], startIndex: number, signal?: AbortSignal): Promise<string> {
  const capability = getModelCapability(SUMMARY_MODEL)
  const apiKeyEnv = capability.provider.apiKeyEnv
  const apiKey = apiKeyEnv ? process.env[apiKeyEnv] ?? "" : ""
  if (!apiKey) throw new Error(`${apiKeyEnv ?? "模型 API Key"} 未设置`)
  const result = await runTurn(chatCompletionsUrl(capability.provider.baseUrl), apiKey, SUMMARY_MODEL, [
    { role: "system", content: "你只做当前 conversation 的上下文摘要压缩。只输出摘要正文。" },
    { role: "user", content: summaryPrompt(oldSummary, rows, startIndex) },
  ], [], () => {}, { thinking: false, adapter: capability.provider.adapter, deferTextUntilTurnEnd: true, signal, timeoutMs: 120_000 })
  if (result.failed || !result.content.trim()) throw new Error("摘要模型生成失败")
  return result.content.trim()
}

async function compact(supabase: SupabaseServer, userId: string, conversationId: string, signal?: AbortSignal): Promise<void> {
  const [{ data: conversation }, { data: messages, error: messageError }] = await Promise.all([
    supabase.from("conversations").select("context_summary, summary_until_message_id").eq("id", conversationId).eq("user_id", userId).maybeSingle(),
    supabase.from("messages").select("id, role, content, images").eq("conversation_id", conversationId).eq("user_id", userId).order("created_at", { ascending: true }),
  ])
  if (!conversation || messageError) return
  const rows = (messages ?? []) as MessageRow[]
  let marker = typeof conversation.summary_until_message_id === "string" ? conversation.summary_until_message_id : null
  let oldSummary = typeof conversation.context_summary === "string" ? conversation.context_summary : ""
  if ((marker && !rows.some(row => row.id === marker)) || (oldSummary && !marker)) {
    marker = null
    oldSummary = ""
    await supabase.from("conversations").update({ context_summary: null, summary_until_message_id: null, summary_token_count: 0 })
      .eq("id", conversationId).eq("user_id", userId)
  }
  if (rows.length <= RECENT_CONTEXT_MESSAGES) return
  const coveredIndex = marker ? rows.findIndex(row => row.id === marker) : -1
  const foldRows = rows.slice(0, rows.length - RECENT_CONTEXT_MESSAGES).slice(coveredIndex + 1)
  if (foldRows.length < SUMMARY_TRIGGER_MESSAGES) return
  const nextSummary = await summarize(oldSummary, foldRows, coveredIndex + 1, signal)
  const nextMarker = foldRows.at(-1)?.id
  if (!nextMarker) return

  let update = supabase.from("conversations").update({
    context_summary: nextSummary,
    summary_until_message_id: nextMarker,
    summary_token_count: Math.ceil(nextSummary.length / 3),
  }).eq("id", conversationId).eq("user_id", userId)
  update = marker ? update.eq("summary_until_message_id", marker) : update.is("summary_until_message_id", null)
  const { error } = await update
  if (error) log.warn("contextSummary", "Failed to save compacted context", error)
}

export async function prepareConversationSummary(options: {
  supabase: SupabaseServer | null
  userId: string | null
  explicitConversationId: unknown
  messages: RawMsg[]
  signal?: AbortSignal
  allowCompaction?: boolean
}): Promise<{ conversationId: string | null; renderedSummary: string }> {
  const { supabase, userId, explicitConversationId, messages, signal, allowCompaction = true } = options
  const conversationId = await resolveConversationId(supabase, userId, explicitConversationId, messages)
  if (!supabase || !userId || !conversationId) return { conversationId, renderedSummary: "" }
  try {
    let state = await readState(supabase, userId, conversationId)
    if (allowCompaction && shouldCompact(messages, state)) {
      await compact(supabase, userId, conversationId, signal)
      state = await readState(supabase, userId, conversationId)
    }
    const renderedSummary = state.summary
      ? `\n\n【当前 conversation 的隐藏上下文摘要】\n下面内容只用于保持当前聊天连贯。它不是 Memory，不是 Project 记忆，不要向用户提及它的存在。\n${state.summary}`
      : ""
    return { conversationId, renderedSummary }
  } catch (error) {
    if (signal?.aborted) throw error
    log.warn("contextSummary", "Context compaction skipped", error)
    return { conversationId, renderedSummary: "" }
  }
}

export { RECENT_CONTEXT_MESSAGES }
