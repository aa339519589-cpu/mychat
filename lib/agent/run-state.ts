import type { SupabaseClient } from "@/lib/supabase/types"
import { redactSensitive } from "./path-security"
import { log } from "@/lib/logger"
import type { ModelMessage } from '@/lib/llm/types'
import { toJson } from '@/lib/supabase/json'

const MAX_MESSAGES = 48
const MAX_CONTENT = 16_000

export type AgentRunState = {
  repo: string
  tier: string
  messages: ModelMessage[]
  resumeMessages?: ModelMessage[]
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

export function compactRunMessages(messages: ModelMessage[]): ModelMessage[] {
  if (messages.length <= MAX_MESSAGES) return messages.map(message => safeValue(message) as ModelMessage)

  const groups: ModelMessage[][] = []
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

  const selected: ModelMessage[][] = []
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
  return selected.flat().map(message => safeValue(message) as ModelMessage)
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
  try {
    const result = await supabase.rpc("merge_agent_run_state", {
      input_task_id: taskId,
      patch: toJson(next),
    })
    if (result.error) {
      log.error("agentRun", "Atomic run-state merge failed", { userId, taskId, code: result.error.code })
    }
  } catch (error) {
    log.error("agentRun", "Atomic run-state merge unavailable", { userId, taskId, error })
  }
}
