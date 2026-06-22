import { NextRequest } from 'next/server'
import pdfParse from 'pdf-parse'

export async function POST(req: NextRequest) {
  try {
    const { dataUrl, isPdf, text } = await req.json()
    if (!isPdf) {
      return Response.json({ text: typeof text === 'string' ? text : '' })
    }
    const b64 = typeof dataUrl === 'string' ? (dataUrl.split(',')[1] ?? '') : ''
    if (!b64) return Response.json({ text: '' })
    const buf = Buffer.from(b64, 'base64')
    const data = await pdfParse(buf)
    return Response.json({ text: data.text || '' })
  } catch (e: any) {
    return Response.json({ text: '', error: e?.message ?? '解析失败' })
  }
}
