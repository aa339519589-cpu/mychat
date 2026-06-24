import { NextRequest, NextResponse } from 'next/server'
import { runInSandbox } from '@/lib/sandbox'

export async function POST(req: NextRequest) {
  let body: any = {}
  try { body = await req.json() } catch { return NextResponse.json({ error: '请求体格式错误' }, { status: 400 }) }

  const command = String(body.command ?? '').trim()
  if (!command) return NextResponse.json({ error: '缺少 command' }, { status: 400 })

  const files = body.files as Record<string, string> | undefined

  const result = runInSandbox(command, files)
  return NextResponse.json(result)
}
