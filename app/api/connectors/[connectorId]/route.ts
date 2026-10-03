import { NextRequest } from 'next/server'
import { resolveAuth, enforceLimits } from '@/lib/api/guard'
import { readJson, requestErrorResponse } from '@/lib/api/request'
import { createAdminClient } from '@/lib/supabase/admin'
import { revokeConnectorAuthorization } from '@/lib/mcp/connector-oauth-flow'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type RouteContext = { params: Promise<{ connectorId: string }> }

async function routeIdentity(request: Request, context: RouteContext) {
  const auth = await resolveAuth(request)
  if (!auth.supabase || !auth.userId) {
    return { response: Response.json({ error: '请先登录' }, { status: 401 }) }
  }
  const { connectorId } = await context.params
  if (!UUID.test(connectorId)) {
    return { response: Response.json({ error: '连接器 ID 无效' }, { status: 400 }) }
  }
  const admin = createAdminClient()
  if (!admin) return { response: Response.json({ error: '连接器存储未就绪' }, { status: 503 }) }
  return { auth, userId: auth.userId, connectorId, admin }
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  const identity = await routeIdentity(request, context)
  if ('response' in identity) return identity.response
  const gate = await enforceLimits(identity.auth, request, { quota: false })
  if (gate.response) return gate.response
  let body: Record<string, unknown>
  try { body = await readJson(request, { maxBytes: 4 * 1024 }) }
  catch (error) { return requestErrorResponse(error) }
  if (typeof body.enabled !== 'boolean') {
    return Response.json({ error: 'enabled 必须是布尔值' }, { status: 400 })
  }
  const { data, error } = await identity.admin.from('mcp_connectors')
    .update({ enabled: body.enabled, updated_at: new Date().toISOString() })
    .eq('id', identity.connectorId).eq('user_id', identity.userId)
    .select('id,enabled').maybeSingle()
  if (error) return Response.json({ error: '更新连接器失败' }, { status: 503 })
  if (!data) return Response.json({ error: '连接器不存在' }, { status: 404 })
  return Response.json({ id: data.id, enabled: data.enabled })
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  const identity = await routeIdentity(request, context)
  if ('response' in identity) return identity.response
  const gate = await enforceLimits(identity.auth, request, { quota: false })
  if (gate.response) return gate.response
  const { data, error } = await identity.admin.from('mcp_connectors').delete()
    .eq('id', identity.connectorId).eq('user_id', identity.userId)
    .select('id,user_id,server_url,credential_ciphertext,auth_type,oauth_status,enabled').maybeSingle()
  if (error) return Response.json({ error: '删除连接器失败' }, { status: 503 })
  if (!data) return Response.json({ ok: true, revocation: 'already_disconnected' })
  const revocation = await revokeConnectorAuthorization(data)
  return Response.json({ ok: true, revocation })
}
