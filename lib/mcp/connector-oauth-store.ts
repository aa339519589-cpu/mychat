import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import { createHash, randomUUID } from 'node:crypto'
import { refreshAuthorization, selectResourceURL } from '@modelcontextprotocol/sdk/client/auth.js'
import { InvalidGrantError, InvalidClientError, UnauthorizedClientError } from '@modelcontextprotocol/sdk/server/auth/errors.js'
import { createAdminClient } from '@/lib/supabase/admin'
import type { SupabaseClient } from '@/lib/supabase/types'
import { connectorOAuthFetch } from './connector-oauth-fetch'
import { ConnectorOAuthError, ConnectorOAuthProvider, openOAuthState, sealOAuthState, type ConnectorOAuthState } from './connector-oauth-state'
import { openConnectorSecret } from './connector-secret'

export function oauthStateHash(state: string) { return createHash('sha256').update(state).digest('hex') }
export type OAuthConnectorRow = {
  id: string; user_id: string; server_url: string; credential_ciphertext: string | null
  auth_type: string; oauth_status: string; enabled: boolean
}
export function connectorContext(row: Pick<OAuthConnectorRow, 'id' | 'user_id' | 'server_url'>) {
  return { connectorId: row.id, userId: row.user_id, serverUrl: row.server_url }
}
export function oauthStore() {
  const admin = createAdminClient()
  if (!admin) throw new ConnectorOAuthError('连接器存储未就绪', 503)
  return admin
}
export async function ownedOAuthConnector(admin: SupabaseClient, userId: string, id: string): Promise<OAuthConnectorRow> {
  const { data, error } = await admin.from('mcp_connectors')
    .select('id,user_id,server_url,credential_ciphertext,auth_type,oauth_status,enabled')
    .eq('id', id).eq('user_id', userId).maybeSingle()
  if (error) throw new ConnectorOAuthError('连接器存储未就绪', 503)
  if (!data) throw new ConnectorOAuthError('连接器不存在', 404)
  return data
}
export async function saveOAuthConnection(admin: SupabaseClient, row: OAuthConnectorRow, state: ConnectorOAuthState) {
  delete state.verifier
  const { data, error } = await admin.from('mcp_connectors').update({
    credential_ciphertext: sealOAuthState(state, connectorContext(row)), auth_type: 'oauth',
    oauth_status: 'connected', enabled: true, oauth_refresh_lease: null, oauth_refresh_until: null,
    updated_at: new Date().toISOString(),
  }).eq('id', row.id).eq('user_id', row.user_id).select('id').maybeSingle()
  if (error || !data) throw new ConnectorOAuthError('保存授权失败，请重新连接', 503)
}
function tokenIsFresh(state: ConnectorOAuthState): boolean {
  return Boolean(state.tokens?.access_token && (state.expiresAt === undefined || state.expiresAt > Date.now() + 30_000))
}
async function releaseRefreshLease(admin: SupabaseClient, row: OAuthConnectorRow, lease: string, reauthorize: boolean) {
  const { error } = await admin.from('mcp_connectors').update({ ...(reauthorize ? { oauth_status: 'reauth_required' } : {}),
    oauth_refresh_lease: null, oauth_refresh_until: null, updated_at: new Date().toISOString() })
    .eq('id', row.id).eq('user_id', row.user_id).eq('oauth_refresh_lease', lease)
  if (error) throw new ConnectorOAuthError('授权状态保存失败', 503)
}
async function refreshOAuthCredential(admin: SupabaseClient, row: OAuthConnectorRow, fetchFn: FetchLike): Promise<string> {
  const lease = randomUUID()
  const { data, error } = await admin.rpc('claim_connector_oauth_refresh', {
    input_user_id: row.user_id, input_connector_id: row.id, input_lease: lease,
  })
  if (error) throw new ConnectorOAuthError('无法取得授权刷新锁', 503)
  if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.ciphertext !== 'string') {
    throw new ConnectorOAuthError('授权正在刷新，请稍后重试', 409)
  }
  try {
    const state = openOAuthState(data.ciphertext, connectorContext(row))
    if (!tokenIsFresh(state)) {
      if (!state.tokens?.refresh_token || !state.discovery || !state.client) throw new ConnectorOAuthError('授权已过期，请重新授权')
      const provider = new ConnectorOAuthProvider(state)
      provider.saveTokens(await refreshAuthorization(state.discovery.authorizationServerUrl, {
        metadata: state.discovery.authorizationServerMetadata, clientInformation: state.client,
        refreshToken: state.tokens.refresh_token,
        resource: await selectResourceURL(row.server_url, provider, state.discovery.resourceMetadata),
        fetchFn,
      }))
    }
    return await commitRefreshedCredential(admin, row, state, lease)
  } catch (failure) {
    const reauthorize = requiresReauthorization(failure)
    await releaseRefreshLease(admin, row, lease, reauthorize)
    if (reauthorize) throw new ConnectorOAuthError('授权已失效，请重新授权', 401)
    throw new ConnectorOAuthError('授权服务暂时不可用，请稍后重试', 503)
  }
}
async function commitRefreshedCredential(admin: SupabaseClient, row: OAuthConnectorRow, state: ConnectorOAuthState, lease: string) {
  const { data, error } = await admin.from('mcp_connectors').update({
    credential_ciphertext: sealOAuthState(state, connectorContext(row)), oauth_refresh_lease: null,
    oauth_refresh_until: null, updated_at: new Date().toISOString(),
  }).eq('id', row.id).eq('user_id', row.user_id).eq('oauth_refresh_lease', lease).eq('enabled', true)
    .select('id').maybeSingle()
  if (error || !data) throw new ConnectorOAuthError('授权已发生变化，请重试', 503)
  return state.tokens!.access_token
}
export async function connectorAccessToken(admin: SupabaseClient, row: OAuthConnectorRow, fetchFn: FetchLike = connectorOAuthFetch): Promise<string | null> {
  if (!row.credential_ciphertext) {
    if (row.auth_type === 'oauth') throw new ConnectorOAuthError('此连接器需要授权')
    return null
  }
  if (row.auth_type !== 'oauth') {
    const token = openConnectorSecret(row.credential_ciphertext, connectorContext(row))
    if (!token) throw new ConnectorOAuthError('连接器凭据无法解密，请重新添加')
    return token
  }
  if (row.oauth_status !== 'connected') throw new ConnectorOAuthError('此连接器需要重新授权')
  const state = openOAuthState(row.credential_ciphertext, connectorContext(row))
  if (tokenIsFresh(state)) return state.tokens!.access_token
  return refreshOAuthCredential(admin, row, fetchFn)
}

function requiresReauthorization(failure: unknown): boolean {
  return failure instanceof InvalidGrantError || failure instanceof InvalidClientError
    || failure instanceof UnauthorizedClientError || (failure instanceof ConnectorOAuthError && failure.status === 409)
}
