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
  if (error || !data) return []
  return data.map(r => ({
    id: r.id as string,
    content: r.content as string,
    timestamp: (r.updated_at as string) || (r.created_at as string) || undefined,
  }))
}

export async function insertMemory(userId: string, content: string): Promise<Memory | null> {
  const supabase = createClient()
  const id = crypto.randomUUID()
  const ts = new Date().toISOString()
  const { error } = await supabase.from("memories").insert({ id, user_id: userId, content })
  if (error) { console.error("insertMemory", error); return null }
  return { id, content, timestamp: ts }
}

export async function updateMemory(id: string, content: string): Promise<void> {
  const supabase = createClient()
  const { error } = await supabase
    .from("memories")
    .update({ content, updated_at: new Date().toISOString() })
    .eq("id", id)
  if (error) console.error("updateMemory", error)
}

export async function deleteMemoryRow(id: string): Promise<void> {
  const supabase = createClient()
  const { error } = await supabase.from("memories").delete().eq("id", id)
  if (error) console.error("deleteMemoryRow", error)
}
