import type { Message } from "@/lib/chat-data"
import { parseArtifact, artifactTitle } from "@/lib/artifact"
import { stripToolMarkup } from "@/lib/llm/content-filter"
import { normalizeMathDelimiters } from "@/lib/math"

export function fmtDate(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) return "今日"
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

// 取最后一条有内容的消息做列表预览
export function lastExcerpt(msgs: Message[]): string {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const t = conversationExcerpt(msgs[i].content)
    if (t) return t
  }
  return ""
}

export function conversationExcerpt(text?: string): string {
  const clean = stripToolMarkup(text ?? "").trim()
  if (!clean) return ""
  const parsed = parseArtifact(clean)
  const display = previewText(parsed.display)
  if (display) return display.slice(0, 60)
  if (parsed.vegaRaw) return "图表"
  if (parsed.mermaidRaw) return "流程图"
  if (parsed.fnPlotRaw) return "函数图像"
  if (parsed.inlineRaw) return "图形"
  if (parsed.raw) return artifactTitle(parsed.raw)
  return previewText(clean).slice(0, 60)
}

function previewText(text: string): string {
  return normalizeMathDelimiters(text)
    .replace(/\$\$([\s\S]*?)\$\$/g, (_match, body: string) => body.trim())
    .replace(/\$([^$\n]+?)\$/g, (_match, body: string) => body.trim())
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, " ")
    .trim()
}
