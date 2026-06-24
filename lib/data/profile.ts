// 用户档案、记忆总开关与额度快照
import { createClient } from "@/lib/supabase/client"

export type Profile = { memoryEnabled: boolean }

export type QuotaSnapshot = {
  tokens5h: number
  window5hStart: string
  tokens7d: number
  window7dStart: string
  balance: number
}

// 读取当前登录用户的档案；没有行就返回默认值
export async function fetchProfile(): Promise<Profile> {
  const supabase = createClient()
  const { data } = await supabase.from("profiles").select("memory_enabled").maybeSingle()
  return {
    memoryEnabled: data?.memory_enabled ?? true,
  }
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
  if (error) console.error("ensureProfile", error)
}

// 切换记忆总开关
export async function setMemoryEnabled(userId: string, enabled: boolean): Promise<void> {
  const supabase = createClient()
  const { error } = await supabase
    .from("profiles")
    .upsert({ user_id: userId, memory_enabled: enabled }, { onConflict: "user_id" })
  if (error) console.error("setMemoryEnabled", error)
}
