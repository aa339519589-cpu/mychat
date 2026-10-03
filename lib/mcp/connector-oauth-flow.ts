import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import { randomBytes, randomUUID } from 'node:crypto'
import { auth } from '@modelcontextprotocol/sdk/client/auth.js'
import type { SupabaseClient } from '@/lib/supabase/types'
import { resolveModelEndpoint } from '@/lib/llm/openai-compatible/addresses'
import { connectorSecretEncryptionConfigured } from './connector-secret'
import { connectorOAuthFetch } from './connector-oauth-fetch'
import { ConnectorOAuthError, ConnectorOAuthProvider, openOAuthState, sealOAuthState, validateCallbackIssuer, httpsOAuthURL, type ConnectorOAuthState } from './connector-oauth-state'
import { connectorContext, oauthStateHash, ownedOAuthConnector, saveOAuthConnection, type OAuthConnectorRow } from './connector-oauth-store'
import { discoverRemoteConnectorTools, validateRemoteConnectorUrl } from './remote-connectors-core'

type OAuthFlowDependencies = {
  fetchFn?: FetchLike
  resolveAuthorizationURL?: typeof resolveModelEndpoint
  discoverTools?: typeof discoverRemoteConnectorTools
}

async function connectorForAuthorization(admin: SupabaseClient, userId: string, input: Record<string, unknown>) {
  if (typeof input.connectorId === 'string') {
    if (!/^[0-9a-f-]{36}$/i.test(input.connectorId)) throw new ConnectorOAuthError('连接器 ID 无效', 400)
    const row = await ownedOAuthConnector(admin, userId, input.connectorId)
    if (row.auth_type !== 'oauth') throw new ConnectorOAuthError('这个连接器没有使用 OAuth', 400)
    return row
  }
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (!name || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) throw new ConnectorOAuthError('连接器名称必须为 1 到 80 个字符', 400)
  const serverUrl = validateRemoteConnectorUrl(input.serverUrl)
  const count = await admin.from('mcp_connectors').select('id', { count: 'exact', head: true }).eq('user_id', userId)
  if (count.error || count.count === null) throw new ConnectorOAuthError('连接器存储未就绪', 503)
  if (count.count >= 10) throw new ConnectorOAuthError('每个账号最多添加 10 个连接器', 409)
  const { data, error } = await admin.from('mcp_connectors').insert({ id: randomUUID(), user_id: userId,
    name, server_url: serverUrl, auth_type: 'oauth', oauth_status: 'pending', enabled: false, tools: [] })
    .select('id,user_id,server_url,credential_ciphertext,auth_type,oauth_status,enabled').single()
  if (error || !data) throw new ConnectorOAuthError('创建授权连接器失败，请检查是否重名', 409)
  return data
}
function initialAuthorizationState(row: OAuthConnectorRow, input: Record<string, unknown>): ConnectorOAuthState {
  const state: ConnectorOAuthState = row.credential_ciphertext
    ? openOAuthState(row.credential_ciphertext, connectorContext(row)) : { type: 'mychat-mcp-oauth', version: 1 }
  delete state.tokens; delete state.expiresAt; delete state.verifier
  if (input.clientId !== undefined) {
    if (typeof input.clientId !== 'string' || !input.clientId.trim() || input.clientId.length > 2048) {
      throw new ConnectorOAuthError('OAuth 客户端 ID 无效', 400)
    }
    state.client = { client_id: input.clientId.trim() }
    if (input.clientSecret !== undefined) {
      if (typeof input.clientSecret !== 'string' || !input.clientSecret || input.clientSecret.length > 4096) {
        throw new ConnectorOAuthError('OAuth 客户端密钥无效', 400)
      }
      state.client = { ...state.client, client_secret: input.clientSecret }
    }
  }
  return state
}
export async function startConnectorAuthorization(admin: SupabaseClient, userId: string, input: Record<string, unknown>, dependencies: OAuthFlowDependencies = {}) {
  if (!connectorSecretEncryptionConfigured()) throw new ConnectorOAuthError('连接器凭据加密尚未配置', 503)
  const row = await connectorForAuthorization(admin, userId, input)
  try {
    const state = randomBytes(32).toString('base64url')
    const provider = new ConnectorOAuthProvider(initialAuthorizationState(row, input), state)
    const result = await auth(provider, { serverUrl: row.server_url, fetchFn: dependencies.fetchFn ?? connectorOAuthFetch })
    if (result !== 'REDIRECT' || !provider.authorizationURL) throw new ConnectorOAuthError('授权服务没有返回登录地址', 502)
    await (dependencies.resolveAuthorizationURL ?? resolveModelEndpoint)(provider.authorizationURL, AbortSignal.timeout(10_000))
    await persistAuthorizationSession(admin, row, state, provider.value)
    return { connectorId: row.id, attemptId: oauthStateHash(state), authorizationUrl: provider.authorizationURL.toString(), expiresIn: 600 }
  } catch (error) {
    // Only remove the never-connected placeholder created by this request.
    if (row.oauth_status === 'pending' && !input.connectorId) {
      await admin.from('mcp_connectors').delete().eq('id', row.id).eq('user_id', userId).eq('oauth_status', 'pending')
    }
    throw error
  }
}
async function persistAuthorizationSession(admin: SupabaseClient, row: OAuthConnectorRow, state: string, value: ConnectorOAuthState) {
  const hash = oauthStateHash(state)
  const context = { ...connectorContext(row), connectorId: `${row.id}:${hash}` }
  const { error: cleanup } = await admin.from('mcp_oauth_sessions').delete().eq('user_id', row.user_id).eq('connector_id', row.id)
  if (cleanup) throw new ConnectorOAuthError('无法更新授权会话', 503)
  const { error } = await admin.from('mcp_oauth_sessions').insert({ state_hash: hash,
    user_id: row.user_id, connector_id: row.id, server_url: row.server_url,
    secret_ciphertext: sealOAuthState(value, context), expires_at: new Date(Date.now() + 600_000).toISOString() })
  if (error) throw new ConnectorOAuthError('无法保存授权会话', 503)
}
async function consumeAuthorizationSession(admin: SupabaseClient, params: URLSearchParams) {
  const state = params.get('state') ?? ''
  if (!/^[A-Za-z0-9_-]{43}$/.test(state)) throw new ConnectorOAuthError('授权状态无效', 400)
  const hash = oauthStateHash(state)
  // DELETE RETURNING is the single-use claim, including concurrent callbacks.
  const { data, error } = await admin.from('mcp_oauth_sessions').delete()
    .eq('state_hash', hash).gt('expires_at', new Date().toISOString()).select('*').maybeSingle()
  if (error || !data) throw new ConnectorOAuthError('授权已过期或已使用，请重新授权', 400)
  const context = { userId: data.user_id, connectorId: `${data.connector_id}:${hash}`, serverUrl: data.server_url }
  return { session: data, value: openOAuthState(data.secret_ciphertext, context) }
}
export async function finishConnectorAuthorization(admin: SupabaseClient, params: URLSearchParams, dependencies: OAuthFlowDependencies = {}) {
  const { session, value } = await consumeAuthorizationSession(admin, params)
  if (params.has('error')) throw new ConnectorOAuthError('授权已取消或被拒绝', 400)
  validateCallbackIssuer(value, params.get('iss'))
  const code = params.get('code') ?? ''
  if (!code || code.length > 8192) throw new ConnectorOAuthError('授权码无效', 400)
  const row = await ownedOAuthConnector(admin, session.user_id, session.connector_id)
  if (row.server_url !== session.server_url || row.auth_type !== 'oauth') throw new ConnectorOAuthError('连接器已改变，请重新授权')
  const provider = new ConnectorOAuthProvider(value)
  if (await auth(provider, { serverUrl: row.server_url, authorizationCode: code, fetchFn: dependencies.fetchFn ?? connectorOAuthFetch }) !== 'AUTHORIZED') {
    throw new ConnectorOAuthError('授权未完成', 502)
  }
  const discovered = await (dependencies.discoverTools ?? discoverRemoteConnectorTools)({ serverUrl: row.server_url, accessToken: provider.value.tokens!.access_token })
  await saveOAuthConnection(admin, row, provider.value)
  const { error } = await admin.from('mcp_connectors').update({ tools: discovered.tools as never })
    .eq('id', row.id).eq('user_id', row.user_id)
  if (error) throw new ConnectorOAuthError('授权成功，但工具清单保存失败，请刷新工具', 503)
  return row.id
}
export async function revokeConnectorAuthorization(row: OAuthConnectorRow, fetchFn: FetchLike = connectorOAuthFetch): Promise<'revoked' | 'unsupported' | 'failed'> {
  if (row.auth_type !== 'oauth' || !row.credential_ciphertext) return 'unsupported'
  try {
    const value = openOAuthState(row.credential_ciphertext, connectorContext(row))
    const metadata = value.discovery?.authorizationServerMetadata as Record<string, unknown> | undefined
    if (typeof metadata?.revocation_endpoint !== 'string' || !value.tokens || !value.client) return 'unsupported'
    const url = httpsOAuthURL(metadata.revocation_endpoint)
    const token = value.tokens.refresh_token ?? value.tokens.access_token
    const body = new URLSearchParams({ token, client_id: value.client.client_id,
      token_type_hint: value.tokens.refresh_token ? 'refresh_token' : 'access_token' })
    const response = await fetchFn(url, revocationRequest(value.client, metadata, body))
    return response.ok ? 'revoked' : 'failed'
  } catch { return 'failed' }
}

function revocationRequest(client: NonNullable<ConnectorOAuthState['client']>, metadata: Record<string, unknown>, body: URLSearchParams) {
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' }
  if ('client_secret' in client && client.client_secret) {
    const methods = metadata.revocation_endpoint_auth_methods_supported ?? metadata.token_endpoint_auth_methods_supported
    if (Array.isArray(methods) && !methods.includes('client_secret_basic') && methods.includes('client_secret_post')) {
      body.set('client_secret', client.client_secret)
    } else {
      headers.Authorization = `Basic ${Buffer.from(`${encodeURIComponent(client.client_id)}:${encodeURIComponent(client.client_secret)}`).toString('base64')}`
    }
  }
  return { method: 'POST', headers, body }
}
