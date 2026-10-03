import { NextRequest } from 'next/server'
import { resolveAuth, enforceLimits } from '@/lib/api/guard'
import { createAdminClient } from '@/lib/supabase/admin'
import { connectorAccessToken, ownedOAuthConnector } from '@/lib/mcp/connector-oauth-store'
import { ConnectorOAuthError } from '@/lib/mcp/connector-oauth-state'
import { discoverRemoteConnectorTools, RemoteConnectorError } from '@/lib/mcp/remote-connectors'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ connectorId: string }> },
) {
  const auth = await resolveAuth(request)
  if (!auth.supabase || !auth.userId) return Response.json({ error: '请先登录' }, { status: 401 })
  const gate = await enforceLimits(auth, request, { quota: false })
  if (gate.response) return gate.response
  const { connectorId } = await params
  if (!UUID.test(connectorId)) return Response.json({ error: '连接器 ID 无效' }, { status: 400 })
  const admin = createAdminClient()
  if (!admin) return Response.json({ error: '连接器存储未就绪' }, { status: 503 })
  try {
    const row = await ownedOAuthConnector(admin, auth.userId, connectorId)
    const credentials = { serverUrl: row.server_url, accessToken: await connectorAccessToken(admin, row) }
    const discovered = await discoverRemoteConnectorTools(credentials, request.signal)
    const { error: updateError } = await admin.from('mcp_connectors').update({
      tools: discovered.tools as never,
      updated_at: new Date().toISOString(),
    }).eq('id', connectorId).eq('user_id', auth.userId)
    if (updateError) return Response.json({ error: '保存连接器工具清单失败' }, { status: 503 })
    return Response.json({
      connected: true,
      serverName: discovered.serverName,
      toolCount: discovered.tools.length,
      tools: discovered.tools.map(tool => ({
        name: tool.name,
        title: tool.title ?? tool.name,
        description: tool.description ?? '',
        readOnly: tool.annotations?.readOnlyHint === true,
      })),
    })
  } catch (failure) {
    if ((failure instanceof RemoteConnectorError || failure instanceof ConnectorOAuthError)) {
      return Response.json({ error: failure.message }, { status: failure.status })
    }
    return Response.json({ error: '刷新连接器失败，请稍后重试' }, { status: 502 })
  }
}
