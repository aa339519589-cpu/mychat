export { MAX_CONNECTOR_TOOLS, MAX_TOOLS_PER_CONNECTOR, MAX_CONNECTOR_RESULT_CHARS, MAX_AUTO_CONNECTOR_TOOLS, MAX_ON_DEMAND_CONNECTOR_RESULTS, MCP_APPS_EXTENSION_ID, MCP_APPS_RESOURCE_MIME, MAX_CONNECTOR_APP_HTML_BYTES, MAX_CONNECTOR_APP_CALL_BYTES, RemoteConnectorError, isRecord } from './remote-connectors-shared'
import { MAX_TOOLS_PER_CONNECTOR, MCP_APPS_EXTENSION_ID, MCP_APPS_RESOURCE_MIME, MAX_CONNECTOR_APP_HTML_BYTES, RemoteConnectorError, isRecord } from './remote-connectors-shared'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import { safeModelEndpointFetch } from '@/lib/llm/openai-compatible/safe-fetch'
import type { SupabaseClient } from '@/lib/supabase/types'
import type { ToolSchema } from '@/lib/tools/types'
import { openConnectorSecret } from './connector-secret'
import { connectorAccessToken, ownedOAuthConnector } from './connector-oauth-store'

export type ConnectorFetch = typeof safeModelEndpointFetch

export type RemoteConnectorToolUI = {
  resourceUri: string
  visibility?: Array<'model' | 'app'>
}

export type RemoteConnectorTool = {
  name: string
  title?: string
  description?: string
  inputSchema: ToolSchema
  ui?: RemoteConnectorToolUI
  annotations?: {
    title?: string
    readOnlyHint?: boolean
    destructiveHint?: boolean
    idempotentHint?: boolean
    openWorldHint?: boolean
  }
}

export type RemoteConnectorAppResource = {
  resourceUri: string
  html: string
  csp: {
    connectDomains: string[]
    resourceDomains: string[]
    frameDomains: string[]
    baseUriDomains: string[]
  }
  prefersBorder?: boolean
}

export type RemoteConnector = {
  id: string
  userId: string
  name: string
  serverUrl: string
  accessToken: string | null
  authorizationError?: string
  resolveAccessToken?: () => Promise<string | null>
  tools: RemoteConnectorTool[]
  enabled: boolean
}

type StoredConnector = {
  id?: unknown
  user_id?: unknown
  name?: unknown
  server_url?: unknown
  enabled?: unknown
  credential_ciphertext?: unknown
  auth_type?: unknown
  oauth_status?: unknown
  tools?: unknown
}

export function validateRemoteConnectorUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2_048 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new RemoteConnectorError('MCP 服务地址无效')
  }
  let url: URL
  try { url = new URL(value.trim()) } catch {
    throw new RemoteConnectorError('MCP 服务地址必须是完整的 HTTPS 地址')
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new RemoteConnectorError('MCP 自定义连接只接受 HTTPS 地址，且不能包含用户名、密码或锚点')
  }
  return url.toString()
}

function abortSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(12_000)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

export function createRemoteTransport(
  connector: Pick<RemoteConnector, 'serverUrl' | 'accessToken'>,
  signal?: AbortSignal,
  fetchImpl: ConnectorFetch = safeModelEndpointFetch,
) {
  const requestSignal = abortSignal(signal)
  const headers = connector.accessToken
    ? { Authorization: `Bearer ${connector.accessToken}` }
    : undefined
  return new StreamableHTTPClientTransport(new URL(connector.serverUrl), {
    requestInit: headers ? { headers } : undefined,
    fetch: (input, init) => fetchImpl(input, {
      ...init,
      signal: init?.signal ? AbortSignal.any([init.signal, requestSignal]) : requestSignal,
    }),
  })
}

export function createRemoteClient(): Client {
  return new Client({ name: 'mychat', version: '1.0.0' }, {
    capabilities: {
      extensions: {
        [MCP_APPS_EXTENSION_ID]: { mimeTypes: [MCP_APPS_RESOURCE_MIME] },
      },
    },
  })
}

function safeToolSchema(value: unknown): ToolSchema | null {
  if (!isRecord(value) || value.type !== 'object' || !isRecord(value.properties)) return null
  let encoded: string
  try { encoded = JSON.stringify(value) } catch { return null }
  if (encoded.length > 32_000) return null
  const cloned = JSON.parse(encoded) as Record<string, unknown>
  const required = Array.isArray(cloned.required)
    ? cloned.required.filter((item): item is string => typeof item === 'string' && item.length <= 128)
    : undefined
  return {
    ...cloned,
    type: 'object',
    properties: cloned.properties as Record<string, unknown>,
    ...(required?.length ? { required } : {}),
  }
}

export function boundedString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim()
  return normalized ? normalized.slice(0, max) : undefined
}

function mapToolUI(value: unknown): RemoteConnectorToolUI | undefined {
  if (!isRecord(value) || typeof value.resourceUri !== 'string') return undefined
  const resourceUri = value.resourceUri.trim()
  if (resourceUri.length > 2_048 || /[\u0000-\u001f\u007f]/.test(resourceUri)) return undefined
  let parsed: URL
  try { parsed = new URL(resourceUri) } catch { return undefined }
  if (parsed.protocol !== 'ui:' || !parsed.hostname || parsed.username || parsed.password || parsed.hash) {
    return undefined
  }
  const visibility = Array.isArray(value.visibility)
    ? [...new Set(value.visibility.filter((item): item is 'model' | 'app' => item === 'model' || item === 'app'))]
    : undefined
  return {
    resourceUri,
    ...(visibility !== undefined ? { visibility } : {}),
  }
}

function mapRemoteTool(value: Tool): RemoteConnectorTool | null {
  const name = boundedString(value.name, 128)
  const inputSchema = safeToolSchema(value.inputSchema)
  if (!name || !inputSchema) return null
  const metadata = isRecord(value._meta) ? value._meta : undefined
  const ui = metadata && isRecord(metadata.ui) ? mapToolUI(metadata.ui) : undefined
  return {
    name,
    ...toolDisplayFields(value.title, value.description, value.annotations),
    inputSchema,
    ...(ui ? { ui } : {}),
  }
}

function mappedAnnotations(value: unknown): RemoteConnectorTool['annotations'] | undefined {
  if (!isRecord(value)) return undefined
  const title = boundedString(value.title, 128)
  return {
    ...(title ? { title } : {}),
    ...(typeof value.readOnlyHint === 'boolean' ? { readOnlyHint: value.readOnlyHint } : {}),
    ...(typeof value.destructiveHint === 'boolean' ? { destructiveHint: value.destructiveHint } : {}),
    ...(typeof value.idempotentHint === 'boolean' ? { idempotentHint: value.idempotentHint } : {}),
    ...(typeof value.openWorldHint === 'boolean' ? { openWorldHint: value.openWorldHint } : {}),
  }
}

function toolDisplayFields(titleValue: unknown, descriptionValue: unknown, annotationsValue: unknown): {
  title?: string
  description?: string
  annotations?: RemoteConnectorTool['annotations']
} {
  const title = boundedString(titleValue, 128)
  const description = boundedString(descriptionValue, 2_000)
  const annotations = mappedAnnotations(annotationsValue)
  return {
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(annotations ? { annotations } : {}),
  }
}

function mapStoredTool(value: unknown): RemoteConnectorTool | null {
  if (!isRecord(value)) return null
  const name = boundedString(value.name, 128)
  const inputSchema = safeToolSchema(value.inputSchema)
  if (!name || !inputSchema) return null
  const ui = mapToolUI(value.ui)
  return {
    name,
    ...toolDisplayFields(value.title, value.description, value.annotations),
    inputSchema,
    ...(ui ? { ui } : {}),
  }
}

function validConnectorId(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}

function mapStoredConnector(value: StoredConnector, userId: string): RemoteConnector | null {
  if (!validConnectorId(value.id) || value.user_id !== userId || typeof value.name !== 'string'
    || typeof value.server_url !== 'string' || value.enabled !== true || !Array.isArray(value.tools)) return null
  let serverUrl: string
  try { serverUrl = validateRemoteConnectorUrl(value.server_url) } catch { return null }
  const tools = value.tools.slice(0, MAX_TOOLS_PER_CONNECTOR)
    .map(mapStoredTool).filter((tool): tool is RemoteConnectorTool => tool !== null)
  if (!tools.length) return null
  const cipher = typeof value.credential_ciphertext === 'string' ? value.credential_ciphertext : null
  const accessToken = value.auth_type === 'oauth' ? null
    : cipher ? openConnectorSecret(cipher, { userId, connectorId: value.id, serverUrl }) : null
  if (value.auth_type !== 'oauth' && cipher && !accessToken) return null
  return { id: value.id, userId, name: value.name.slice(0, 80), serverUrl, accessToken, tools, enabled: true }
}

export async function loadRemoteConnectors(
  supabase: SupabaseClient,
  userId: string,
  connectorIds?: readonly string[],
): Promise<RemoteConnector[]> {
  if (connectorIds?.length === 0) return []
  const query = supabase.from('mcp_connectors')
    .select('id,user_id,name,server_url,enabled,credential_ciphertext,auth_type,oauth_status,tools')
    .eq('user_id', userId)
    .eq('enabled', true)
  const scopedQuery = connectorIds === undefined
    ? query
    : query.in('id', connectorIds.map(id => id.toLowerCase()))
  const { data, error } = await scopedQuery.order('created_at', { ascending: true })
  if (error || !Array.isArray(data)) return []
  const connectors: RemoteConnector[] = []
  for (const value of (data as unknown as StoredConnector[]).slice(0, 10)) {
    const connector = mapStoredConnector(value, userId)
    if (!connector) continue
    if (value.auth_type === 'oauth') {
      connector.resolveAccessToken = async () => {
        const current = await ownedOAuthConnector(supabase, userId, connector.id)
        if (!current.enabled || current.server_url !== connector.serverUrl) {
          throw new RemoteConnectorError('连接器已关闭或改变，请重新选择', 409)
        }
        return connectorAccessToken(supabase, current)
      }
    }
    connectors.push(connector)
  }
  return connectors
}

export async function discoverRemoteConnectorTools(
  connector: Pick<RemoteConnector, 'serverUrl' | 'accessToken'>,
  signal?: AbortSignal,
  fetchImpl: ConnectorFetch = safeModelEndpointFetch,
): Promise<{ tools: RemoteConnectorTool[]; serverName: string | null }> {
  const normalizedUrl = validateRemoteConnectorUrl(connector.serverUrl)
  const client = createRemoteClient()
  try {
    await client.connect(createRemoteTransport({ ...connector, serverUrl: normalizedUrl }, signal, fetchImpl))
    const result = await client.listTools()
    const tools = result.tools.slice(0, MAX_TOOLS_PER_CONNECTOR)
      .map(mapRemoteTool)
      .filter((tool): tool is RemoteConnectorTool => tool !== null)
    if (!tools.length) throw new RemoteConnectorError('MCP 服务没有提供可用工具')
    return { tools, serverName: boundedString(client.getServerVersion()?.name, 128) ?? null }
  } catch (error) {
    if (error instanceof RemoteConnectorError) throw error
    throw new RemoteConnectorError('连接 MCP 服务或读取工具清单失败；请检查 HTTPS 地址、认证令牌和服务状态', 502)
  } finally {
    await client.close().catch(() => undefined)
  }
}

function validCspHostname(hostname: string): boolean {
  if (!hostname.includes('*')) return true
  if (!/^\*\.[a-z0-9.-]+$/i.test(hostname)) return false
  return hostname.slice(2).split('.').every(part =>
    Boolean(part) && !part.startsWith('-') && !part.endsWith('-'))
}

function safeCspOrigin(item: unknown, field: 'connect' | 'resource'): string | null {
  if (typeof item !== 'string' || item.length > 512) return null
  const candidate = item.trim()
  if (!candidate || /[\u0000-\u0020\u007f'";]/.test(candidate)) return null
  let parsed: URL
  try { parsed = new URL(candidate) } catch { return null }
  const allowedProtocols = field === 'connect' ? ['https:', 'wss:'] : ['https:']
  if (!allowedProtocols.includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password
    || parsed.pathname !== '/' || parsed.search || parsed.hash || !validCspHostname(parsed.hostname)) return null
  return `${parsed.protocol}//${parsed.host}`
}

function safeCspDomains(value: unknown, field: 'connect' | 'resource'): string[] {
  if (!Array.isArray(value)) return []
  const origins = value.slice(0, 32).map(item => safeCspOrigin(item, field))
  return [...new Set(origins.filter((origin): origin is string => origin !== null))]
}

function uiResourceMetadata(value: unknown): RemoteConnectorAppResource['csp'] & { prefersBorder?: boolean } {
  const root = isRecord(value) ? value : {}
  const ui = isRecord(root.ui) ? root.ui : {}
  const csp = isRecord(ui.csp) ? ui.csp : {}
  return {
    connectDomains: safeCspDomains(csp.connectDomains, 'connect'),
    resourceDomains: safeCspDomains(csp.resourceDomains, 'resource'),
    frameDomains: safeCspDomains(csp.frameDomains, 'resource'),
    baseUriDomains: safeCspDomains(csp.baseUriDomains, 'resource'),
    ...(typeof ui.prefersBorder === 'boolean' ? { prefersBorder: ui.prefersBorder } : {}),
  }
}

function resourceHTML(value: unknown, expectedUri: string): { html: string; metadata: ReturnType<typeof uiResourceMetadata> } {
  if (!isRecord(value) || value.uri !== expectedUri) {
    throw new RemoteConnectorError('连接器返回了不匹配的界面资源', 502)
  }
  const mimeType = typeof value.mimeType === 'string' ? value.mimeType.toLowerCase().replace(/\s/g, '') : ''
  const mimeParts = mimeType.split(';')
  if (mimeParts[0] !== 'text/html' || !mimeParts.includes('profile=mcp-app')) {
    throw new RemoteConnectorError('连接器界面资源类型不受支持', 415)
  }
  let html: string
  if (typeof value.text === 'string') {
    html = value.text
  } else if (typeof value.blob === 'string') {
    const blob = value.blob
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(blob)
      || blob.length > Math.ceil(MAX_CONNECTOR_APP_HTML_BYTES / 3) * 4 + 4) {
      throw new RemoteConnectorError('连接器界面资源超出大小限制', 413)
    }
    const data = Buffer.from(blob, 'base64')
    if (data.byteLength > MAX_CONNECTOR_APP_HTML_BYTES || data.toString('base64') !== blob) {
      throw new RemoteConnectorError('连接器界面资源超出大小限制', 413)
    }
    try { html = new TextDecoder('utf-8', { fatal: true }).decode(data) }
    catch { throw new RemoteConnectorError('连接器界面资源不是有效的 UTF-8 HTML', 502) }
  } else {
    throw new RemoteConnectorError('连接器没有返回 HTML 界面资源', 502)
  }
  if (Buffer.byteLength(html, 'utf8') > MAX_CONNECTOR_APP_HTML_BYTES || !/^\s*(?:<!doctype\s+html|<html\b)/i.test(html)) {
    throw new RemoteConnectorError('连接器界面 HTML 无效或超出大小限制', 413)
  }
  return { html, metadata: uiResourceMetadata(value._meta) }
}

export async function readRemoteConnectorAppResource(
  connector: Pick<RemoteConnector, 'serverUrl' | 'accessToken' | 'authorizationError' | 'resolveAccessToken'>,
  tool: RemoteConnectorTool,
  signal?: AbortSignal,
  fetchImpl: ConnectorFetch = safeModelEndpointFetch,
): Promise<RemoteConnectorAppResource> {
  if (!tool.ui?.resourceUri) throw new RemoteConnectorError('该工具没有交互界面', 404)
  const normalizedUrl = validateRemoteConnectorUrl(connector.serverUrl)
  if (connector.authorizationError) throw new RemoteConnectorError(connector.authorizationError, 401)
  const client = createRemoteClient()
  try {
    await client.connect(createRemoteTransport({
      serverUrl: normalizedUrl,
      accessToken: connector.resolveAccessToken ? await connector.resolveAccessToken() : connector.accessToken,
    }, signal, fetchImpl))
    const response = await client.readResource({ uri: tool.ui.resourceUri })
    const matches = response.contents.filter(item => item.uri === tool.ui?.resourceUri)
    if (matches.length !== 1) throw new RemoteConnectorError('连接器界面资源缺失或重复', 502)
    const { html, metadata } = resourceHTML(matches[0], tool.ui.resourceUri)
    return {
      resourceUri: tool.ui.resourceUri,
      html,
      csp: {
        connectDomains: metadata.connectDomains,
        resourceDomains: metadata.resourceDomains,
        frameDomains: metadata.frameDomains,
        baseUriDomains: metadata.baseUriDomains,
      },
      ...(metadata.prefersBorder !== undefined ? { prefersBorder: metadata.prefersBorder } : {}),
    }
  } catch (error) {
    if (error instanceof RemoteConnectorError) throw error
    throw new RemoteConnectorError('无法读取连接器交互界面资源', 502)
  } finally {
    await client.close().catch(() => undefined)
  }
}
