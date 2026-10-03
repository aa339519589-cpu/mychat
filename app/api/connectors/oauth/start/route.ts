import { resolveAuth, enforceLimits } from '@/lib/api/guard'
import { readJson, requestErrorResponse } from '@/lib/api/request'
import { oauthStore } from '@/lib/mcp/connector-oauth-store'
import { startConnectorAuthorization } from '@/lib/mcp/connector-oauth-flow'
import { ConnectorOAuthError } from '@/lib/mcp/connector-oauth-state'

export async function POST(request: Request) {
  const auth = await resolveAuth(request)
  if (!auth.userId || auth.authUnavailable) return Response.json({ error: '请先登录' }, { status: 401 })
  if (auth.isAnonymous) return Response.json({ error: '请登录后连接账号' }, { status: 403 })
  const gate = await enforceLimits(auth, request, { quota: false })
  if (gate.response) return gate.response
  let input: Record<string, unknown>
  try { input = await readJson(request, { maxBytes: 8 * 1024 }) }
  catch (error) { return requestErrorResponse(error) }
  try { return Response.json(await startConnectorAuthorization(oauthStore(), auth.userId, input), { headers: { 'Cache-Control': 'no-store' } }) }
  catch (error) {
    return Response.json({ error: error instanceof ConnectorOAuthError ? error.message : '无法开始 OAuth 授权；服务可能需要预注册客户端 ID' },
      { status: error instanceof ConnectorOAuthError ? error.status : 502 })
  }
}
