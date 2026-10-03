import { ConnectorOAuthError, httpsOAuthURL } from './connector-oauth-state'
import { connectorOAuthFetch } from './connector-oauth-fetch'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'

type DirectoryEntry = { id: string; name: string; description: string; serverUrl: string; websiteUrl?: string }
function object(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}
function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : ''
}
function remoteEntries(value: unknown): DirectoryEntry[] {
  const row = object(value); const server = object(row?.server)
  if (!server || typeof server.name !== 'string' || !Array.isArray(server.remotes)) return []
  const official = object(object(row?._meta)?.['io.modelcontextprotocol.registry/official'])
  if (official?.status && official.status !== 'active') return []
  return server.remotes.flatMap(remote => {
    const endpoint = object(remote)
    if (endpoint?.type !== 'streamable-http' || typeof endpoint.url !== 'string'
      || /[{}]/.test(endpoint.url) || (Array.isArray(endpoint.headers) && endpoint.headers.length > 0)) return []
    try {
      const url = httpsOAuthURL(endpoint.url).toString()
      return [{ id: `${text(server.name, 180)}:${url}`, name: text(server.title ?? server.name, 80),
        description: text(server.description, 1000), serverUrl: url,
        ...(typeof server.websiteUrl === 'string' ? { websiteUrl: httpsOAuthURL(server.websiteUrl).toString() } : {}) }]
    } catch { return [] }
  })
}
export async function searchConnectorDirectory(search: string, cursor?: string, fetchFn: FetchLike = connectorOAuthFetch) {
  if (search.length > 120 || (cursor?.length ?? 0) > 1024) throw new ConnectorOAuthError('目录查询过长', 400)
  const url = new URL('https://registry.modelcontextprotocol.io/v0.1/servers')
  url.searchParams.set('version', 'latest'); url.searchParams.set('limit', '40')
  if (search.trim()) url.searchParams.set('search', search.trim())
  if (cursor) url.searchParams.set('cursor', cursor)
  const response = await fetchFn(url, { headers: { Accept: 'application/json' } })
  if (!response.ok) throw new ConnectorOAuthError('连接器目录暂时不可用，请稍后重试', 502)
  const body = object(await response.json())
  if (!body || !Array.isArray(body.servers)) throw new ConnectorOAuthError('连接器目录响应无效', 502)
  const entries = body.servers.flatMap(remoteEntries).slice(0, 40)
  const nextCursor = text(object(body.metadata)?.nextCursor, 1024) || null
  return { entries, nextCursor, source: 'MCP Registry' }
}
