import { NextRequest } from 'next/server'
import { log } from '@/lib/logger'

// PDF 文字提取已移至前端（pdfjs-dist + CMap），此端点现在只透传已提取的 text 字段
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const text = typeof body.text === 'string' ? body.text : ''
    return Response.json({ text })
  } catch (e) {
    log.error('extract', 'Failed to parse request body', e)
    return Response.json({ text: '', error: '解析失败' }, { status: 400 })
  }
}
