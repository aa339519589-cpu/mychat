// 用户档案、记忆总开关、系统提示词与额度快照
import { createClient } from "@/lib/supabase/client"
import { MAX_CUSTOM_SYSTEM_PROMPT_CHARS } from "@/lib/user-system-prompt"

export type Profile = { memoryEnabled: boolean }

export type QuotaSnapshot = {
  tokens5h: number
  window5hStart: string
  tokens7d: number
  window7dStart: string
  balance: number
}

type SystemPromptResponse = { prompt?: unknown; error?: unknown }
type MemorySettingResponse = { enabled?: unknown; error?: unknown }

async function memorySettingResponse(
  method: "GET" | "PUT",
  enabled?: boolean,
): Promise<boolean> {
  const response = await fetch("/api/profile/memory", {
    method,
    cache: "no-store",
    credentials: "same-origin",
    headers: method === "PUT" ? { "Content-Type": "application/json" } : undefined,
    body: method === "PUT" ? JSON.stringify({ enabled }) : undefined,
  })
  let body: MemorySettingResponse = {}
  try {
    body = await response.json() as MemorySettingResponse
  } catch {
    // Keep a stable fallback when an intermediary returns non-JSON.
  }
  if (!response.ok || typeof body.enabled !== "boolean") {
    throw new Error(
      typeof body.error === "string" && body.error
        ? body.error
        : method === "GET" ? "记忆设置加载失败，请稍后重试" : "记忆设置保存失败，请稍后重试",
    )
  }
  if (method === "PUT" && body.enabled !== enabled) {
    throw new Error("记忆设置保存结果不一致，请重试")
  }
  return body.enabled
}

async function systemPromptResponse(response: Response, fallback: string): Promise<string> {
  let body: SystemPromptResponse = {}
  try {
    body = await response.json() as SystemPromptResponse
  } catch {
    // Keep the user-facing fallback when an intermediary returns non-JSON.
  }
  if (!response.ok) {
    throw new Error(typeof body.error === "string" && body.error ? body.error : fallback)
  }
  if (typeof body.prompt !== "string") throw new Error(fallback)
  return body.prompt
}

// 读取当前登录用户的档案；没有行就返回默认值
export async function fetchProfile(): Promise<Profile> {
  return {
    memoryEnabled: await memorySettingResponse("GET"),
  }
}

export async function fetchCustomSystemPrompt(): Promise<string> {
  const response = await fetch("/api/profile/system-prompt", {
    method: "GET",
    cache: "no-store",
    credentials: "same-origin",
  })
  return systemPromptResponse(response, "系统提示词加载失败，请稍后重试")
}

export async function saveCustomSystemPrompt(value: string): Promise<string> {
  if (value.trim().length > MAX_CUSTOM_SYSTEM_PROMPT_CHARS) {
    throw new Error(`系统提示词最多 ${MAX_CUSTOM_SYSTEM_PROMPT_CHARS.toLocaleString()} 字`)
  }
  const response = await fetch("/api/profile/system-prompt", {
    method: "PUT",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: value }),
  })
  return systemPromptResponse(response, "系统提示词保存失败，请稍后重试")
}

// 读取当前用户的 Token 使用额度快照
export async function fetchQuota(): Promise<QuotaSnapshot> {
  const supabase = createClient()
  const { data: auth } = await supabase.auth.getUser()
  const nowIso = new Date().toISOString()
  if (!auth.user) {
    return {
      tokens5h: 0,
      window5hStart: nowIso,
      tokens7d: 0,
      window7dStart: nowIso,
      balance: 0,
    }
  }
  const { data } = await supabase
    .from("profiles")
    .select("tokens_5h, window_5h_start, tokens_7d, window_7d_start, balance")
    .eq("user_id", auth.user.id)
    .maybeSingle()
  return {
    tokens5h: (data?.tokens_5h as number) ?? 0,
    window5hStart: (data?.window_5h_start as string) ?? nowIso,
    tokens7d: (data?.tokens_7d as number) ?? 0,
    window7dStart: (data?.window_7d_start as string) ?? nowIso,
    balance: (data?.balance as number) ?? 0,
  }
}

// 确保档案行存在（登录后调用一次）；已存在则不动
export async function ensureProfile(userId: string): Promise<void> {
  const supabase = createClient()
  const { error } = await supabase
    .from("profiles")
    .upsert({ user_id: userId }, { onConflict: "user_id", ignoreDuplicates: true })
  if (error) throw error
}

// 切换记忆总开关。写入失败必须向上抛出，禁止静默伪装成功。
export async function setMemoryEnabled(_userId: string, enabled: boolean): Promise<void> {
  await memorySettingResponse("PUT", enabled)
}
