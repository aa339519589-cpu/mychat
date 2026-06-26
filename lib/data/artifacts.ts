import { createClient } from "@/lib/supabase/client"
import type { ArtifactLibraryItem } from "@/lib/artifact-data"
import { fmtDate } from "./shared"

function normalizeArtifactRow(r: any): ArtifactLibraryItem {
  return {
    id: r.id as string,
    title: (r.title as string) || "未命名作品",
    raw: (r.raw as string) || "",
    conversationId: (r.conversation_id as string) ?? null,
    messageId: (r.message_id as string) ?? null,
    projectId: (r.project_id as string) ?? null,
    date: fmtDate((r.created_at as string) || new Date().toISOString()),
    createdAt: (r.created_at as string) || undefined,
  }
}

export async function fetchArtifacts(): Promise<ArtifactLibraryItem[]> {
  const supabase = createClient()
  const { data, error } = await supabase
    .from("artifacts")
    .select("id, title, raw, conversation_id, message_id, project_id, created_at")
    .order("created_at", { ascending: false })
    .limit(100)
  if (error || !data) return []
  return data.map(normalizeArtifactRow)
}

export async function insertArtifactFromMessage(args: {
  userId: string
  conversationId: string
  messageId: string
  title: string
  raw: string
}): Promise<ArtifactLibraryItem | null> {
  const supabase = createClient()
  const { data: conv } = await supabase
    .from("conversations")
    .select("project_id")
    .eq("id", args.conversationId)
    .maybeSingle()

  const id = crypto.randomUUID()
  const row = {
    id,
    user_id: args.userId,
    conversation_id: args.conversationId,
    message_id: args.messageId,
    project_id: (conv as { project_id?: string | null } | null)?.project_id ?? null,
    title: args.title,
    raw: args.raw,
  }

  const { data, error } = await supabase
    .from("artifacts")
    .upsert(row, { onConflict: "message_id" })
    .select("id, title, raw, conversation_id, message_id, project_id, created_at")
    .maybeSingle()

  if (error || !data) {
    if (error) console.error("insertArtifactFromMessage", error)
    return null
  }
  return normalizeArtifactRow(data)
}

export async function deleteArtifactRow(id: string): Promise<void> {
  const supabase = createClient()
  const { error } = await supabase.from("artifacts").delete().eq("id", id)
  if (error) console.error("deleteArtifactRow", error)
}
