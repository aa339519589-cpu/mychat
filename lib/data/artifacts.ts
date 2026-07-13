import { createClient } from "@/lib/supabase/client"
import type { ArtifactLibraryItem } from "@/lib/artifact-data"
import { fmtDate } from "./shared"

type ArtifactRow = {
  id: string
  title: string | null
  raw: string | null
  conversation_id: string | null
  message_id: string | null
  project_id: string | null
  created_at: string | null
}

function normalizeArtifactRow(row: ArtifactRow): ArtifactLibraryItem {
  return {
    id: row.id,
    title: row.title || "未命名作品",
    raw: row.raw || "",
    conversationId: row.conversation_id,
    messageId: row.message_id,
    projectId: row.project_id,
    date: fmtDate(row.created_at || new Date().toISOString()),
    createdAt: row.created_at || undefined,
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
  return (data as ArtifactRow[]).map(normalizeArtifactRow)
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
  return normalizeArtifactRow(data as ArtifactRow)
}

export async function deleteArtifactRow(id: string): Promise<void> {
  const supabase = createClient()
  const { error } = await supabase.from("artifacts").delete().eq("id", id)
  if (error) console.error("deleteArtifactRow", error)
}
