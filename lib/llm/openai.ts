// OpenAI / DeepSeek / Gemini 兼容协议：消息转换、附件注入。
// 单轮请求（runTurn）已拆到 turn.ts，多轮循环拆到 agent-loop.ts。
import type { RawMsg, Attachment } from './types'
import { buildModelContext } from './context'
import { getModelCapability } from './models'

export function toOpenAI(msgs: RawMsg[]) {
  return buildModelContext(msgs, getModelCapability('deepseek-v4-flash'))
}

export function chatCompletionsUrl(baseUrl: string) {
  const base = baseUrl.trim().replace(/\/$/, '')
  if (base.endsWith('/chat/completions')) return base
  if (base.endsWith('/v1')) return `${base}/chat/completions`
  return `${base}/v1/chat/completions`
}

// 注入附件：附件最终都已是纯文字（文本文件 / 有文字层的 PDF / 扫描件经小米 Omni OCR），直接拼进末条用户消息
export async function injectAttachmentsOpenAI(msgs: any[], attachments?: Attachment[]) {
  if (!attachments?.length) return
  const last = msgs[msgs.length - 1]
  if (!last || last.role !== 'user') return

  const textParts: string[] = []
  for (const f of attachments) {
    if (f.text) textParts.push(`［附件：${f.name}］\n${f.text}`)
  }
  if (!textParts.length) return

  const textBlock = textParts.join('\n\n')
  if (typeof last.content === 'string') {
    last.content = `${last.content}\n\n${textBlock}`.trim()
  } else if (Array.isArray(last.content)) {
    last.content.push({ type: 'text', text: textBlock })
  }
}
