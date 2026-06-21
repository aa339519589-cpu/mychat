export type Memory = { id: string; content: string }

const KEY = "chat_memories"

export function loadMemories(): Memory[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((m: any) => m && typeof m.id === "string" && typeof m.content === "string")
  } catch { return [] }
}

export function saveMemories(mems: Memory[]): void {
  try { localStorage.setItem(KEY, JSON.stringify(mems)) } catch {}
}
