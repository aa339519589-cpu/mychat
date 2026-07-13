import type { Message } from "@/lib/chat-data"
import { normalizeGeneratedMediaList } from "@/lib/generated-media"
import {
  generationTerminalWarning,
  normalizeMessageGeneration,
} from "@/lib/generation-message"
import { isRecord } from "@/lib/unknown-value"

export type MessageRow = {
  id: string
  role: "user" | "assistant"
  content: string | null
  images: unknown
  thinking: string | null
  created_at: string | null
}

export type ConversationRow = {
  id: string
  title: string
  updated_at: string
  project_id: string | null
  starred?: boolean | null
  pinned?: boolean | null
  messages?: Array<{ count?: number | null }> | null
}

export function normalizeMessageRow(row: MessageRow): Message {
  const stored = row.images
  const storedRecord = isRecord(stored) ? stored : null
  const generation = storedRecord
    ? normalizeMessageGeneration(storedRecord.generation)
    : undefined
  const images = Array.isArray(stored)
    ? stored.filter((value): value is string => typeof value === "string")
    : Array.isArray(storedRecord?.refs)
      ? storedRecord.refs.filter((value: unknown): value is string => typeof value === "string")
      : undefined
  const imageSummary = storedRecord && typeof storedRecord.image_summary === "string"
    ? storedRecord.image_summary
    : undefined
  const media = storedRecord ? normalizeGeneratedMediaList(storedRecord.generated_media) : []

  return {
    id: row.id,
    role: row.role,
    content: row.content ?? "",
    thinking: row.thinking || undefined,
    images: images?.length ? images : undefined,
    imageSummary,
    media: media.length ? media : undefined,
    isError: generation?.status === "failed" ? true : undefined,
    outputWarning: generationTerminalWarning(generation),
    generation,
    time: "",
    ts: row.created_at || undefined,
  }
}
