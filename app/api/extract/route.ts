import { NextRequest } from 'next/server'
import { extractText, getDocumentProxy } from 'unpdf'

// 把上传的项目资料抽成纯文本：PDF 用 unpdf 解析，文本类直接回传。
// 失败也返回 200 + 空文本，由前端决定是否仍要保存（不让单个坏文件中断上传流程）。
export async function POST(req: NextRequest) {
  try {
    const { dataUrl, isPdf, text } = await req.json()
    if (!isPdf) {
      return Response.json({ text: typeof text === 'string' ? text : '' })
    }
    const b64 = typeof dataUrl === 'string' ? (dataUrl.split(',')[1] ?? '') : ''
    if (!b64) return Response.json({ text: '' })
    const buf = new Uint8Array(Buffer.from(b64, 'base64'))
    const pdf = await getDocumentProxy(buf)
    const { text: out } = await extractText(pdf, { mergePages: true })
    const merged = Array.isArray(out) ? out.join('\n\n') : out
    return Response.json({ text: merged || '' })
  } catch (e: any) {
    return Response.json({ text: '', error: e?.message ?? '解析失败' })
  }
}
