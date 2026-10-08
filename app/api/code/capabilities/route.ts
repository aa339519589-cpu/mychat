import { resolveAuth } from '@/lib/api/guard'
import { codeCapabilities } from '@/lib/code-agent/capabilities'
import { NextRequest } from 'next/server'

export async function GET(request: NextRequest) {
  const auth = await resolveAuth(request)
  if (auth.authUnavailable) return Response.json({ error: '认证服务暂时不可用' }, { status: 503 })
  if (!auth.userId) return Response.json({ error: '请先登录' }, { status: 401 })
  return Response.json(codeCapabilities(), { headers: { 'Cache-Control': 'no-store' } })
}
