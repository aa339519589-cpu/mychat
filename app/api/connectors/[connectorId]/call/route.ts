import { NextRequest } from 'next/server'
import { resolveAuth, enforceLimits } from '@/lib/api/guard'
import { readJson, requestErrorResponse } from '@/lib/api/request'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  callRemoteConnectorAppTool,
  loadRemoteConnectors,
  MAX_CONNECTOR_APP_CALL_BYTES,
  RemoteConnectorError,
  type RemoteConnectorTool,
} from '@/lib/mcp/remote-connectors'
import type { SupabaseClient } from '@/lib/supabase/types'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function validToolName(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim()) && value.length <= 128
    && !/[\u0000-\u001f\u007f]/.test(value)
}

function validToolArguments(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function selectedAppTool(input: {
  userId: string
  connectorId: string
  toolName: string
}): Promise<{ connector: Awaited<ReturnType<typeof loadRemoteConnectors>>[number]; tool: RemoteConnectorTool } | Response> {
  const admin = createAdminClient()
  if (!admin) return Response.json({ error: '连接器存储未就绪' }, { status: 503 })
  const [connector] = await loadRemoteConnectors(admin as unknown as SupabaseClient, input.userId, [input.connectorId])
  if (!connector) return Response.json({ error: '连接器不存在、已停用或不属于当前账号' }, { status: 404 })
  const tool = connector.tools.find(candidate => candidate.name === input.toolName)
  if (!tool?.ui?.resourceUri || !(tool.ui.visibility === undefined || tool.ui.visibility.includes('app'))) {
    return Response.json({ error: '该工具没有授权给连接器界面' }, { status: 403 })
  }
  return { connector, tool }
}

async function callSelectedAppTool(
  request: NextRequest,
  connectorId: string,
  userId: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<Response> {
  const selected = await selectedAppTool({ userId, connectorId, toolName })
  if (selected instanceof Response) return selected
  try {
    const result = await callRemoteConnectorAppTool(selected.connector, selected.tool, args, request.signal)
    return Response.json({ result }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) {
    if (error instanceof RemoteConnectorError) {
      return Response.json({ error: error.message }, { status: error.status })
    }
    return Response.json({ error: '连接器工具调用失败，请稍后重试' }, { status: 502 })
  }
}

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
  let body: Record<string, unknown>
  try { body = await readJson(request, { maxBytes: MAX_CONNECTOR_APP_CALL_BYTES + 4 * 1024 }) }
  catch (error) { return requestErrorResponse(error) }
  if (!validToolName(body.toolName) || !validToolArguments(body.arguments)) {
    return Response.json({ error: '连接器工具调用参数无效' }, { status: 400 })
  }
  return callSelectedAppTool(request, connectorId, auth.userId, body.toolName, body.arguments)
}
