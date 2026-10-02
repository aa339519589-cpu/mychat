import { createClient } from "@/lib/supabase/client"
import type { Memory } from "@/lib/memory-data"

// ───────────── 记忆 ─────────────

export async function fetchMemories(): Promise<Memory[]> {
  const supabase = createClient()
  const { data, error } = await supabase
    .from("memories")
    .select("id, content, created_at, updated_at")
    .order("created_at", { ascending: true })
    .limit(200)
  if (error) throw error
  return (data ?? []).map(r => ({
    id: r.id as string,
    content: r.content as string,
    timestamp: (r.updated_at as string) || (r.created_at as string) || undefined,
  }))
}

export async function insertMemory(userId: string, content: string): Promise<Memory> {
  const supabase = createClient()
  const id = crypto.randomUUID()
  const { data, error } = await supabase
    .from("memories")
    .insert({ id, user_id: userId, content })
    .select("id, content, created_at, updated_at")
    .single()
  if (error) throw error
  if (!data) throw new Error("记忆没有保存到服务器，请重试")
  return {
    id: data.id,
    content: data.content,
    timestamp: data.updated_at || data.created_at || undefined,
  }
}

export async function updateMemory(id: string, content: string): Promise<void> {
  const supabase = createClient()
  const { data, error } = await supabase
    .from("memories")
    .update({ content, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select("id")
    .maybeSingle()
  if (error) throw error
  if (!data) throw new Error("这条记忆不存在或无法修改，请刷新后重试")
}

export async function deleteMemoryRow(id: string): Promise<void> {
  const supabase = createClient()
  const { data, error } = await supabase
    .from("memories")
    .delete()
    .eq("id", id)
    .select("id")
    .maybeSingle()
  if (error) throw error
  if (!data) throw new Error("这条记忆不存在或无法删除，请刷新后重试")
}
