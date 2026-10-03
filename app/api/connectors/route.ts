import { NextRequest } from 'next/server'
import { resolveAuth, enforceLimits } from '@/lib/api/guard'
import { readJson, requestErrorResponse } from '@/lib/api/request'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  discoverRemoteConnectorTools,
  RemoteConnectorError,
  validateRemoteConnectorUrl,
} from '@/lib/mcp/remote-connectors'
import { connectorSecretEncryptionConfigured, sealConnectorSecret } from '@/lib/mcp/connector-secret'

const MAX_USER_CONNECTORS = 10

function responseError(error: unknown): Response {
  if (error instanceof RemoteConnectorError) {
    return Response.json({ error: error.message }, { status: error.status })
  }
  return Response.json({ error: 'MCP 连接器操作失败，请稍后重试' }, { status: 500 })
}

function storageUnavailable(): Response {
  return Response.json({ error: '连接器存储未就绪，请先执行最新 Supabase migration' }, { status: 503 })
}

function safeName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return normalized.length > 0 && normalized.length <= 80 ? normalized : null
}

function safeAccessToken(value: unknown): string | null | undefined {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  if (!normalized || normalized.length > 4_096 || /[\r\n\u0000]/.test(normalized)) return undefined
  return normalized
}

function connectorSummary(row: {
  id: string
  name: string
  server_url: string
  enabled: boolean
  credential_ciphertext: string | null
  auth_type: string
  oauth_status: string
  tools: unknown
  created_at: string
  updated_at: string
}) {
  const tools = Array.isArray(row.tools) ? row.tools : []
  const toolSummaries = tools.flatMap(value => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return []
    const item = value as Record<string, unknown>
    if (typeof item.name !== 'string') return []
    return [{
      name: item.name,
      title: typeof item.title === 'string' ? item.title : item.name,
      description: typeof item.description === 'string' ? item.description : '',
      readOnly: typeof item.annotations === 'object' && item.annotations !== null
        && !Array.isArray(item.annotations)
        && (item.annotations as Record<string, unknown>).readOnlyHint === true,
    }]
  })
  return {
    id: row.id,
    name: row.name,
    serverUrl: row.server_url,
    enabled: row.enabled,
    hasAccessToken: Boolean(row.credential_ciphertext),
    authType: row.auth_type,
    authorizationStatus: row.oauth_status,
    toolCount: toolSummaries.length,
    tools: toolSummaries,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

type NewConnectorInput = { name: string; serverUrl: string; accessToken: string | null }

function parseNewConnectorInput(body: Record<string, unknown>): NewConnectorInput | Response {
  const name = safeName(body.name)
  if (!name) return Response.json({ error: '连接器名称必须为 1 到 80 个字符' }, { status: 400 })
  const accessToken = safeAccessToken(body.accessToken)
  if (accessToken === undefined) return Response.json({ error: '访问令牌无效或过长' }, { status: 400 })
  if (accessToken && !connectorSecretEncryptionConfigured()) {
    return Response.json({ error: '连接器凭据加密未配置，请设置至少 32 字符的 AGENT_CREDENTIAL_KEY' }, { status: 503 })
  }
  try {
    return { name, accessToken, serverUrl: validateRemoteConnectorUrl(body.serverUrl) }
  } catch (error) {
    return responseError(error)
  }
}

async function persistNewConnector(input: {
  request: NextRequest
  admin: NonNullable<ReturnType<typeof createAdminClient>>
  userId: string
  connector: NewConnectorInput
}): Promise<Response> {
  const countResult = await input.admin.from('mcp_connectors').select('id', { count: 'exact', head: true })
    .eq('user_id', input.userId)
  if (countResult.error || countResult.count === null) return storageUnavailable()
  if (countResult.count >= MAX_USER_CONNECTORS) {
    return Response.json({ error: `每个账号最多添加 ${MAX_USER_CONNECTORS} 个自定义连接器` }, { status: 409 })
  }
  const id = crypto.randomUUID()
  try {
    const discovered = await discoverRemoteConnectorTools({
      serverUrl: input.connector.serverUrl,
      accessToken: input.connector.accessToken,
    }, input.request.signal)
    const credentialCiphertext = input.connector.accessToken
      ? sealConnectorSecret(input.connector.accessToken, {
        userId: input.userId, connectorId: id, serverUrl: input.connector.serverUrl,
      })
      : null
    const { data, error } = await input.admin.from('mcp_connectors').insert({
      id,
      user_id: input.userId,
      name: input.connector.name,
      server_url: input.connector.serverUrl,
      credential_ciphertext: credentialCiphertext,
      auth_type: input.connector.accessToken ? 'bearer' : 'none',
      tools: discovered.tools as never,
      enabled: true,
      updated_at: new Date().toISOString(),
    }).select('id,name,server_url,enabled,credential_ciphertext,auth_type,oauth_status,tools,created_at,updated_at').single()
    if (error || !data) return storageUnavailable()
    return Response.json({
      connector: connectorSummary(data),
      verification: { connected: true, serverName: discovered.serverName },
    }, { status: 201 })
  } catch (error) {
    return responseError(error)
  }
}

export async function GET(request: Request) {
  const auth = await resolveAuth(request)
  if (!auth.supabase || !auth.userId) return Response.json({ error: '请先登录' }, { status: 401 })
  const admin = createAdminClient()
  if (!admin) return storageUnavailable()
  const { data, error } = await admin.from('mcp_connectors')
    .select('id,name,server_url,enabled,credential_ciphertext,auth_type,oauth_status,tools,created_at,updated_at')
    .eq('user_id', auth.userId)
    .order('created_at', { ascending: true })
  if (error || !Array.isArray(data)) return storageUnavailable()
  return Response.json({ connectors: data.map(row => connectorSummary(row)) })
}

export async function POST(request: NextRequest) {
  const auth = await resolveAuth(request)
  if (!auth.supabase || !auth.userId) return Response.json({ error: '请先登录' }, { status: 401 })
  if (auth.isAnonymous) return Response.json({ error: '请使用已登录账号添加连接器' }, { status: 403 })
  const gate = await enforceLimits(auth, request, { quota: false })
  if (gate.response) return gate.response

  let body: Record<string, unknown>
  try { body = await readJson(request, { maxBytes: 16 * 1024 }) }
  catch (error) { return requestErrorResponse(error) }

  const parsed = parseNewConnectorInput(body)
  if (parsed instanceof Response) return parsed

  const admin = createAdminClient()
  if (!admin) return storageUnavailable()
  return persistNewConnector({ request, admin, userId: auth.userId, connector: parsed })
}
