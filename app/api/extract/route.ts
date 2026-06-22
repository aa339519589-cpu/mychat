import { NextRequest } from 'next/server'

// PDF 文字提取已移至前端（pdfjs-dist + CMap），此端点现在只透传已提取的 text 字段
export async function POST(req: NextRequest) {
  try {
    const { text } = await req.json()
    return Response.json({ text: typeof text === 'string' ? text : '' })
  } catch (e: any) {
    return Response.json({ text: '', error: e?.message ?? '解析失败' })
  }
}
