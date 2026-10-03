import { resolveAuth, enforceLimits } from '@/lib/api/guard'
import { searchConnectorDirectory } from '@/lib/mcp/connector-directory'
import { ConnectorOAuthError } from '@/lib/mcp/connector-oauth-state'

export async function GET(request: Request) {
  const auth = await resolveAuth(request)
  if (!auth.userId || auth.authUnavailable) return Response.json({ error: '请先登录' }, { status: 401 })
  const gate = await enforceLimits(auth, request, { quota: false })
  if (gate.response) return gate.response
  const url = new URL(request.url)
  try { return Response.json(await searchConnectorDirectory(url.searchParams.get('search') ?? '', url.searchParams.get('cursor') ?? undefined)) }
  catch (error) {
    return Response.json({ error: error instanceof ConnectorOAuthError ? error.message : '目录查询失败' },
      { status: error instanceof ConnectorOAuthError ? error.status : 502 })
  }
}
