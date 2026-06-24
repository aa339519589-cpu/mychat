// Agent Task 运行时记录器：封装 step 写入 / tool_call 写入 / 输入清理。
// 由 /api/code/chat 和 /api/code/apply 共用，确保所有 task 操作统一走这条管道。

import type { SupabaseClient } from "@supabase/supabase-js"
import { addStep, addToolCall, completeToolCall, updateTaskStatus, addArtifact } from "./data"

// ── 敏感信息打码 ──

const SENSITIVE_KEYS = [
  "token", "api_key", "apikey", "apiKey", "secret", "password", "passwd",
  "authorization", "auth", "cookie", "set-cookie",
  "gh_access_token", "gh_token", "github_token",
  "supabase_key", "supabase_url",
  "deepseek", "mimo", "tavily",
]

function maskIfSensitive(key: string, val: unknown): unknown {
  const lower = key.toLowerCase().replace(/[_-]/g, "")
  if (SENSITIVE_KEYS.some(k => lower.includes(k))) {
    if (typeof val === "string" && val.length > 0) return `${val.slice(0, 4)}***`
    return "***"
  }
  return val
}

function sanitize(obj: unknown, maxLen = 2000): Record<string, unknown> | null {
  if (!obj || typeof obj !== "object") return null
  const result: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const masked = maskIfSensitive(k, v)
    if (typeof masked === "string" && masked.length > maxLen) {
      result[k] = masked.slice(0, maxLen) + `…(已截断 ${masked.length} 字符)`
    } else {
      result[k] = masked
    }
  }
  return result
}

function truncateOutput(output: string, maxLen = 3000): string {
  if (output.length <= maxLen) return output
  return output.slice(0, maxLen) + `\n…(已截断 ${output.length} 字符)`
}

// ── 上下文 ──

export type RecordCtx = {
  supabase: SupabaseClient | null
  userId: string | null
  taskId: string | null
}

export function createRecorder(ctx: RecordCtx) {
  const { supabase, userId, taskId } = ctx
  const enabled = !!(supabase && userId && taskId)

  // ── 生命周期 step ──
  async function step(kind: string, label: string, detail?: string) {
    if (!enabled) return
    const normalized = kind === "thinking" || kind === "plan" || kind === "confirm"
      ? kind
      : kind === "error" || kind === "failed" || kind === "blocked"
        ? "error"
        : kind === "done" || kind === "completed"
          ? "done"
          : kind === "tool_call"
            ? "tool_call"
            : "info"
    await addStep(supabase!, userId!, taskId!, { kind: normalized, label, detail }).catch(() => {})
  }

  // ── 工具调用包装 ──
  async function recordToolCall(
    toolName: string,
    input: unknown,
    execute: () => Promise<string>,
  ): Promise<string> {
    if (!enabled) return execute()

    const safeInput = sanitize(input) ?? undefined
    let tcId: string | null = null

    // 创建 pending 记录
    const pending = await addToolCall(supabase!, userId!, {
      taskId: taskId!,
      toolName,
      input: safeInput,
      status: "running",
    })
    if ("id" in pending) tcId = pending.id

    // 执行工具
    let output: string
    let status: string = "success"
    let error: string | undefined

    try {
      output = await execute()
    } catch (e: any) {
      output = e?.message ?? String(e)
      status = "error"
      error = e?.message ?? String(e)
    }

    // 完成记录
    if (tcId) {
      await completeToolCall(supabase!, userId!, tcId, {
        status,
        output: { text: truncateOutput(output) },
        error,
      }).catch(() => {})
    }

    return output
  }

  // ── 任务状态更新 ──
  async function setTaskStatus(status: string, error?: string) {
    if (!enabled) return
    const extra: any = {}
    if (error) extra.error = error
    if (status === "running") extra.startedAt = new Date().toISOString()
    if (["completed", "failed", "cancelled"].includes(status)) extra.finishedAt = new Date().toISOString()
    await updateTaskStatus(supabase!, userId!, taskId!, status, extra).catch(() => {})
  }

  // ── 产物 ──
  async function artifact(kind: string, opts: { title?: string; content?: string; url?: string; meta?: Record<string, unknown> }) {
    if (!enabled) return
    await addArtifact(supabase!, userId!, {
      taskId: taskId!,
      kind,
      title: opts.title,
      content: opts.content?.slice(0, 10000),
      url: opts.url,
      meta: opts.meta,
    }).catch(() => {})
  }

  return { step, recordToolCall, setTaskStatus, artifact }
}
