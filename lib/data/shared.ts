import type { Message } from "@/lib/chat-data"

export function fmtDate(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) return "今日"
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

// 取最后一条有内容的消息做列表预览
export function lastExcerpt(msgs: Message[]): string {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const t = msgs[i].content?.trim()
    if (t) return t.slice(0, 60)
  }
  return ""
}
