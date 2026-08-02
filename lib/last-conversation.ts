const LAST_CONVERSATION_KEY = "mychat_last_conversation_id"

export function readLastConversationId(): string | null {
  if (typeof window === "undefined") return null
  try {
    const value = window.localStorage.getItem(LAST_CONVERSATION_KEY)?.trim()
    return value || null
  } catch {
    return null
  }
}

export function writeLastConversationId(id: string | null): void {
  if (typeof window === "undefined") return
  try {
    if (!id) {
      window.localStorage.removeItem(LAST_CONVERSATION_KEY)
      return
    }
    window.localStorage.setItem(LAST_CONVERSATION_KEY, id)
  } catch {
    // Quota / private mode — ignore.
  }
}
