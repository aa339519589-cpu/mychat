import { resolveAuth, enforceLimits } from '@/lib/api/guard'
import { createAdminClient } from '@/lib/supabase/admin'
import { loadRemoteConnectors } from '@/lib/mcp/remote-connectors-core'
import { mcpToolMetadata } from '@/lib/code-tools/registry'
import { createCodeMcpBroker } from '@/lib/code-tools/mcp-broker'

/** Stored discovery is labelled unverified until the task broker performs a
 * live handshake; this endpoint never exposes credential material. */
export async function GET(request: Request) {
  const auth = await resolveAuth(request)
  if (!auth.supabase || !auth.userId) return Response.json({ error: '请先登录' }, { status: 401 })
  const client = createAdminClient()
  if (!client) return Response.json({ error: '连接器存储未就绪' }, { status: 503 })
  const raw = new URL(request.url).searchParams.get('connectorIds')
  const ids = raw === null ? undefined : raw.split(',')
  if (ids && (ids.length > 10 || ids.some(id => !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)))) {
    return Response.json({ error: '连接器 ID 无效' }, { status: 400 })
  }
  const connectors = await loadRemoteConnectors(client, auth.userId, ids)
  if (new URL(request.url).searchParams.get('verify') === '1') {
    const gate = await enforceLimits(auth, request, { quota: false })
    if (gate.response) return gate.response
    const broker = await createCodeMcpBroker({
      userId: auth.userId, mode: 'code', loadConnectors: async () => connectors, signal: request.signal,
    })
    const tools = broker.listTools()
    return Response.json({ tools, toolCount: tools.length, verified: true, connections: broker.connectionHealth() }, {
      headers: { 'Cache-Control': 'private, no-store' },
    })
  }
  const tools = connectors.flatMap(connector => connector.tools.map(tool => mcpToolMetadata(connector, tool)))
  return Response.json({ tools, toolCount: tools.length, verified: false }, {
    headers: { 'Cache-Control': 'private, no-store' },
  })
}
