import type { RawMsg } from "@/lib/llm/types"
import { isRecord } from '@/lib/unknown-value'

function rawMessageText(m: RawMsg): string {
  if (typeof m.content === 'string') return m.content.trim()
  if (Array.isArray(m.content)) {
    return m.content
      .map(value => isRecord(value) && typeof value.text === 'string' ? value.text : '')
      .join('\n')
      .trim()
  }
  return ''
}

export function latestUserQuery(messages: RawMsg[]): string {
  let lastUser = ''
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'user') continue
    const text = rawMessageText(messages[i])
    if (text) { lastUser = text; break }
  }

  const recent = messages
    .slice(-8)
    .map(m => {
      const text = rawMessageText(m).slice(0, 900)
      if (!text) return ''
      return `${m.role === 'assistant' ? '模型' : '用户'}：${text}`
    })
    .filter(Boolean)
    .join('\n')

  return [
    lastUser ? `【当前用户问题】${lastUser}` : '',
    recent ? `【最近几轮上下文】\n${recent}` : '',
  ].filter(Boolean).join('\n\n')
}

