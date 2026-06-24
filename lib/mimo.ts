// 小米 MiMo-V2.5：主聊天视觉模型，同时为纯文本模型生成可缓存的图片摘要。
import { log } from '@/lib/logger'

const MIMO_API_KEY = process.env.MIMO_API_KEY ?? ''
const MIMO_URL = 'https://api.xiaomimimo.com/v1/chat/completions'
const MIMO_MODEL = 'mimo-v2.5'

const OCR_PROMPT =
  '这是文档的扫描/拍照图片。请把图片里的所有文字和数学公式按原文完整识别出来：数学公式用 LaTeX（$...$）表示，保留题号、选项与符号。只输出识别到的内容，不要翻译、不要额外解释、不要加开场白。'

const PAGES_PER_CALL = 3   // 每次请求塞几页（多图一次请求）
const MAX_PAGES = 18       // 单份文档最多识别多少页

const SUMMARY_PROMPT =
  '请准确概括这些图片中对后续对话有用的视觉信息，包括主体、场景、文字、数据、界面状态和关键细节。不要猜测看不清的内容。只输出一段简洁、独立可读的中文摘要，不要加开场白。'

async function understandImages(images: string[], prompt: string, maxTokens: number): Promise<string> {
  if (!MIMO_API_KEY) {
    log.warn('mimo', 'MIMO_API_KEY not configured')
    return ''
  }
  try {
    const res = await fetch(MIMO_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${MIMO_API_KEY}` },
      body: JSON.stringify({
        model: MIMO_MODEL,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            ...images.map(url => ({ type: 'image_url', image_url: { url } })),
          ],
        }],
        thinking: { type: 'disabled' },
        max_completion_tokens: maxTokens,
      }),
    })
    if (!res.ok) {
      log.warn('mimo', 'Vision request failed', { status: res.status, body: (await res.text()).slice(0, 300) })
      return ''
    }
    const json = await res.json()
    return typeof json.choices?.[0]?.message?.content === 'string'
      ? json.choices[0].message.content.trim()
      : ''
  } catch (error) {
    log.error('mimo', 'Vision request error', error)
    return ''
  }
}

// 一批页面图片（data URL）→ 文字
async function ocrChunk(images: string[]): Promise<string> {
  return understandImages(images, OCR_PROMPT, 16_384)
}

export async function summarizeImages(images: string[]): Promise<string> {
  return understandImages(images.slice(0, 8), SUMMARY_PROMPT, 1_024)
}

// 渲染好的页面图片（前端 pdfjs 生成的 data URL 数组）→ 完整文字。分块并行，控制延迟。
export async function ocrPageImages(images: string[]): Promise<string> {
  if (!images?.length) return ''
  const pages = images.slice(0, MAX_PAGES)
  const chunks: string[][] = []
  for (let i = 0; i < pages.length; i += PAGES_PER_CALL) chunks.push(pages.slice(i, i + PAGES_PER_CALL))

  const results = await Promise.all(chunks.map(ocrChunk))
  let text = results.map(r => r.trim()).filter(Boolean).join('\n\n')
  if (images.length > MAX_PAGES) text += `\n\n（注：文档共 ${images.length} 页，已识别前 ${MAX_PAGES} 页）`
  return text
}
