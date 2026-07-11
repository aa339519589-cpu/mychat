import type { SupabaseClient } from "@supabase/supabase-js"
import { redactSensitive } from "./path-security"
import { log } from "@/lib/logger"
import { mergeTaskMeta } from "./meta"

const MAX_MESSAGES = 48
const MAX_CONTENT = 16_000

export type AgentRunState = {
  repo: string
  tier: string
  messages: any[]
  resumeMessages?: any[]
  responseId?: string
  sessionId?: string
  updatedAt: string
}

function safeValue(value: unknown): unknown {
  if (typeof value === "string") return redactSensitive(value).slice(0, MAX_CONTENT)
  if (Array.isArray(value)) return value.slice(0, 50).map(safeValue)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([name, item]) => [name, safeValue(item)]))
}

export function compactRunMessages(messages: any[]): any[] {
  if (messages.length <= MAX_MESSAGES) return messages.map(message => safeValue(message))

  const groups: any[][] = []
  for (let index = 0; index < messages.length;) {
    const message = messages[index]
    if (message?.role === "tool") { index++; continue }
    const group = [message]
    index++
    if (message?.role === "assistant" && Array.isArray(message.tool_calls)) {
      while (index < messages.length && messages[index]?.role === "tool") group.push(messages[index++])
    }
    groups.push(group)
  }

  const selected: any[][] = []
  let count = 0
  for (let index = groups.length - 1; index >= 0; index--) {
    if (count + groups[index].length > MAX_MESSAGES && selected.length) break
    selected.unshift(groups[index])
    count += groups[index].length
  }
  const firstUser = groups.find(group => group[0]?.role === "user")
  if (firstUser && !selected.includes(firstUser)) {
    selected.unshift([{ role: "user", content: `原始任务：${String(firstUser[0]?.content ?? "").slice(0, MAX_CONTENT)}` }])
  }
  return selected.flat().map(message => safeValue(message))
}

export async function saveAgentRunState(
  supabase: SupabaseClient,
  userId: string,
  taskId: string,
  patch: Partial<AgentRunState>,
): Promise<void> {
  const next: Record<string, unknown> = { ...patch, updatedAt: new Date().toISOString() }
  if (Array.isArray(patch.messages)) next.messages = compactRunMessages(patch.messages)
  if (Array.isArray(patch.resumeMessages)) next.resumeMessages = compactRunMessages(patch.resumeMessages)
  let error: { code?: string } | null = null
  try {
    const result = await supabase.rpc("merge_agent_run_state", { input_task_id: taskId, patch: next })
    error = result.error
  } catch {
    error = { code: "RPC_UNAVAILABLE" }
  }
  if (error) {
    log.warn("agentRun", "Atomic run-state merge unavailable; using compatibility fallback", { userId, taskId, code: error.code })
    const { data } = await supabase.from("agent_tasks").select("meta").eq("id", taskId).eq("user_id", userId).single()
    const current = ((data?.meta as Record<string, unknown> | null)?.agentRun ?? {}) as Record<string, unknown>
    await mergeTaskMeta(supabase, userId, taskId, { agentRun: { ...current, ...next } })
  }
}
