import { randomBytes } from 'node:crypto'
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import type { OAuthClientProvider, OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js'
import { openConnectorSecret, sealConnectorSecret, type ConnectorSecretContext } from './connector-secret'

export class ConnectorOAuthError extends Error {
  constructor(message: string, readonly status = 409) { super(message); this.name = 'ConnectorOAuthError' }
}
export type ConnectorOAuthState = {
  type: 'mychat-mcp-oauth'; version: 1; issuer?: string
  client?: OAuthClientInformationMixed; tokens?: OAuthTokens; expiresAt?: number
  discovery?: OAuthDiscoveryState; verifier?: string
}
export const CONNECTOR_OAUTH_ORIGIN = 'https://mychat-nm6x.onrender.com'
export const CONNECTOR_OAUTH_CALLBACK = `${CONNECTOR_OAUTH_ORIGIN}/api/connectors/oauth/callback`
export const CONNECTOR_CLIENT_DOCUMENT = `${CONNECTOR_OAUTH_ORIGIN}/.well-known/mychat-mcp-client`

export function oauthClientMetadata() {
  return { client_name: 'MyChat', client_uri: CONNECTOR_OAUTH_ORIGIN,
    redirect_uris: [CONNECTOR_OAUTH_CALLBACK], grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'], token_endpoint_auth_method: 'none' as const, application_type: 'web' as const }
}
export function httpsOAuthURL(value: string): URL {
  let url: URL
  try { url = new URL(value) } catch { throw new ConnectorOAuthError('OAuth 地址无效', 400) }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || value.length > 4096) {
    throw new ConnectorOAuthError('OAuth 服务必须使用不含凭据的 HTTPS 地址', 400)
  }
  return url
}
export function parseOAuthState(raw: string | null): ConnectorOAuthState | null {
  if (!raw?.startsWith('{')) return null
  try {
    const state = JSON.parse(raw) as ConnectorOAuthState
    if (state.type !== 'mychat-mcp-oauth' || state.version !== 1) return null
    if (state.issuer) httpsOAuthURL(state.issuer)
    if (state.tokens && (typeof state.tokens.access_token !== 'string'
      || state.tokens.token_type?.toLowerCase() !== 'bearer')) return null
    return state
  } catch { return null }
}
export function openOAuthState(cipher: string, context: ConnectorSecretContext): ConnectorOAuthState {
  const state = parseOAuthState(openConnectorSecret(cipher, context))
  if (!state) throw new ConnectorOAuthError('授权凭据无法读取，请重新授权')
  return state
}
export function sealOAuthState(state: ConnectorOAuthState, context: ConnectorSecretContext): string {
  const value = JSON.stringify(state)
  if (Buffer.byteLength(value) > 96 * 1024) throw new ConnectorOAuthError('OAuth 凭据超过大小限制', 413)
  return sealConnectorSecret(value, context)
}
export function validateCallbackIssuer(state: ConnectorOAuthState, returned: string | null): void {
  if (!state.issuer) throw new ConnectorOAuthError('授权服务身份缺失', 400)
  const requiresIssuer = (state.discovery?.authorizationServerMetadata as Record<string, unknown> | undefined)?.authorization_response_iss_parameter_supported === true
  if ((requiresIssuer && !returned) || (returned && returned !== state.issuer)) {
    throw new ConnectorOAuthError('授权服务身份不匹配，请重新授权', 400)
  }
}

/** The SDK performs PKCE, resource binding, CIMD discovery and legacy DCR. */
export class ConnectorOAuthProvider implements OAuthClientProvider {
  readonly redirectUrl = CONNECTOR_OAUTH_CALLBACK
  readonly clientMetadataUrl = CONNECTOR_CLIENT_DOCUMENT
  readonly clientMetadata = oauthClientMetadata()
  authorizationURL?: URL
  constructor(public value: ConnectorOAuthState, private readonly stateValue = randomBytes(32).toString('base64url')) {}
  state() { return this.stateValue }
  clientInformation() { return this.value.client }
  saveClientInformation(client: OAuthClientInformationMixed) { this.value.client = client }
  tokens() { return this.value.tokens }
  saveTokens(tokens: OAuthTokens) {
    if (!tokens.access_token || tokens.token_type.toLowerCase() !== 'bearer') {
      throw new ConnectorOAuthError('授权服务没有返回有效的 Bearer 凭据', 502)
    }
    this.value.tokens = tokens
    this.value.expiresAt = tokens.expires_in === undefined ? undefined : Date.now() + tokens.expires_in * 1000
  }
  redirectToAuthorization(url: URL) { this.authorizationURL = httpsOAuthURL(url.toString()) }
  saveCodeVerifier(verifier: string) { this.value.verifier = verifier }
  codeVerifier() {
    if (!this.value.verifier) throw new ConnectorOAuthError('授权校验码已失效，请重新授权')
    return this.value.verifier
  }
  discoveryState() { return this.value.discovery }
  saveDiscoveryState(discovery: OAuthDiscoveryState) {
    const issuer = discovery.authorizationServerMetadata?.issuer ?? discovery.authorizationServerUrl
    httpsOAuthURL(issuer)
    if (this.value.issuer && this.value.issuer !== issuer) { delete this.value.client; delete this.value.tokens }
    this.value.issuer = issuer
    this.value.discovery = discovery
  }
  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery') {
    if (scope === 'all' || scope === 'client') delete this.value.client
    if (scope === 'all' || scope === 'tokens') { delete this.value.tokens; delete this.value.expiresAt }
    if (scope === 'all' || scope === 'verifier') delete this.value.verifier
    if (scope === 'all' || scope === 'discovery') { delete this.value.discovery; delete this.value.issuer }
  }
}
