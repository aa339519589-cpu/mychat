import { NextRequest } from 'next/server'
import { resolveAuth, enforceLimits } from '@/lib/api/guard'
import { readJson, requestErrorResponse } from '@/lib/api/request'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  loadRemoteConnectors,
  readRemoteConnectorAppResource,
  RemoteConnectorError,
  type RemoteConnectorTool,
} from '@/lib/mcp/remote-connectors'
import type { SupabaseClient } from '@/lib/supabase/types'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function validToolName(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim()) && value.length <= 128
    && !/[\u0000-\u001f\u007f]/.test(value)
}

async function selectedResourceTool(input: {
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
    return Response.json({ error: '该工具没有可用的交互界面' }, { status: 404 })
  }
  return { connector, tool }
}

async function readSelectedResource(
  request: NextRequest,
  connectorId: string,
  userId: string,
  toolName: string,
): Promise<Response> {
  const selected = await selectedResourceTool({ userId, connectorId, toolName })
  if (selected instanceof Response) return selected
  try {
    const resource = await readRemoteConnectorAppResource(selected.connector, selected.tool, request.signal)
    return Response.json(resource, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (error) {
    const status = error instanceof RemoteConnectorError ? error.status : 502
    const message = error instanceof Error ? error.message : '无法读取连接器交互界面'
    return Response.json({ error: message }, { status })
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
  try { body = await readJson(request, { maxBytes: 4 * 1024 }) }
  catch (error) { return requestErrorResponse(error) }
  if (!validToolName(body.toolName)) {
    return Response.json({ error: '工具标识无效' }, { status: 400 })
  }
  return readSelectedResource(request, connectorId, auth.userId, body.toolName)
}
