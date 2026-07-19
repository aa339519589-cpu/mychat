export * from "./shared"
export * from "./profile"
export * from "./memory"
export * from "./conversations"
export * from "./generation-cache"
export * from "./projects"
export * from "./artifacts"
export * from "./endpoints"
export { deleteConversationRow } from "./fast-conversation-delete"
export async function deleteAllConversations(): Promise<void> {
  const response = await fetch('/api/conversations', { method: 'DELETE' })
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string }
    throw new Error(body.error || '全部对话删除失败，请稍后重试。')
  }
}
