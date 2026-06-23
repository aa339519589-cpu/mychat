// 小米 MiMo-V2-Omni：扫描件 PDF 的「视觉解析器」。
// DeepSeek 是纯文本模型读不了扫描件，这里先把页面图片 OCR 成精确文字（含 LaTeX 公式），再喂给 DeepSeek。
// 前端只在后台调用、用户无感知——主聊天模型不变。
import { log } from '@/lib/logger'

const MIMO_API_KEY = 'sk-cucqie22f0d8soyqzp3up9qzvtw9m9gdmx873o6p8fc14luc'
const MIMO_URL = 'https://api.xiaomimimo.com/v1/chat/completions'
const MIMO_MODEL = 'mimo-v2-omni'

const OCR_PROMPT =
  '这是文档的扫描/拍照图片。请把图片里的所有文字和数学公式按原文完整识别出来：数学公式用 LaTeX（$...$）表示，保留题号、选项与符号。只输出识别到的内容，不要翻译、不要额外解释、不要加开场白。'

const PAGES_PER_CALL = 3   // 每次请求塞几页（多图一次请求）
const MAX_PAGES = 18       // 单份文档最多识别多少页

// 一批页面图片（data URL）→ 文字
async function ocrChunk(images: string[]): Promise<string> {
  try {
    const res = await fetch(MIMO_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${MIMO_API_KEY}` },
      body: JSON.stringify({
        model: MIMO_MODEL,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: OCR_PROMPT },
            ...images.map(url => ({ type: 'image_url', image_url: { url } })),
          ],
        }],
      }),
    })
    if (!res.ok) {
      log.warn('mimoOcr', 'OCR request failed', { status: res.status, body: (await res.text()).slice(0, 300) })
      return ''
    }
    const j = await res.json()
    return (j.choices?.[0]?.message?.content as string) ?? ''
  } catch (e) {
    log.error('mimoOcr', 'OCR request error', e)
    return ''
  }
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
