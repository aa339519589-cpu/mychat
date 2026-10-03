import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import type { SupabaseClient } from '@/lib/supabase/types'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import { startConnectorAuthorization, finishConnectorAuthorization, revokeConnectorAuthorization } from '@/lib/mcp/connector-oauth-flow'
import { ConnectorOAuthProvider, openOAuthState, sealOAuthState, parseOAuthState, validateCallbackIssuer, httpsOAuthURL, CONNECTOR_CLIENT_DOCUMENT, type ConnectorOAuthState } from '@/lib/mcp/connector-oauth-state'
import { connectorAccessToken, connectorContext, oauthStateHash, type OAuthConnectorRow } from '@/lib/mcp/connector-oauth-store'
import { searchConnectorDirectory } from '@/lib/mcp/connector-directory'
import { discoverRemoteConnectorTools, loadRemoteConnectors, remoteConnectorTools } from '@/lib/mcp/remote-connectors'
import type { ToolContext } from '@/lib/tools/types'

const userId = '10000000-0000-4000-8000-000000000001'
const serverUrl = 'https://mcp.oauth.test/mcp'
const issuer = 'https://auth.oauth.test'
type Row = Record<string, unknown>
function database() {
  const tables: Record<string, Row[]> = { mcp_connectors: [], mcp_oauth_sessions: [] }
  const client = {
    from(table: string) {
      const filters: Array<(row: Row) => boolean> = []
      let op = 'select', values: Row = {}, singular = false
      const query = {
        select() { return query }, eq(key: string, val: unknown) { filters.push(row => row[key] === val); return query },
        gt(key: string, val: string) { filters.push(row => String(row[key]) > val); return query },
        in(key: string, vals: unknown[]) { filters.push(row => vals.includes(row[key])); return query },
        order() { return query }, insert(row: Row) { op = 'insert'; values = row; return query },
        update(row: Row) { op = 'update'; values = row; return query }, delete() { op = 'delete'; return query },
        single() { singular = true; return query }, maybeSingle() { singular = true; return query },
        then(resolve: (value: unknown) => void) {
          let rows = tables[table].filter(row => filters.every(fn => fn(row)))
          if (op === 'insert') { rows = [{ credential_ciphertext: null, ...values }]; tables[table].push(...rows) }
          if (op === 'update') rows.forEach(row => Object.assign(row, values))
          if (op === 'delete') tables[table] = tables[table].filter(row => !rows.includes(row))
          resolve({ data: singular ? rows[0] ?? null : rows, count: rows.length, error: null })
        },
      }
      return query
    },
    async rpc(name: string, args: Row) {
      assert.equal(name, 'claim_connector_oauth_refresh')
      const row = tables.mcp_connectors.find(row => row.id === args.input_connector_id && row.user_id === args.input_user_id && row.enabled && !row.oauth_refresh_lease)
      if (!row) return { data: null, error: null }
      row.oauth_refresh_lease = args.input_lease
      return { data: { ciphertext: row.credential_ciphertext }, error: null }
    },
  } as unknown as SupabaseClient
  return { client, tables }
}
function authorizationServer(options: { legacy?: boolean; tokenError?: string } = {}) {
  const tokenRequests: URLSearchParams[] = []
  const rpcCalls: string[] = []
  const fetchFn: FetchLike = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.pathname.includes('oauth-protected-resource')) return Response.json({ resource: serverUrl, authorization_servers: [issuer] })
    if (url.pathname.includes('oauth-authorization-server')) return Response.json({
      issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`,
      registration_endpoint: `${issuer}/register`, revocation_endpoint: `${issuer}/revoke`,
      response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'],
      authorization_response_iss_parameter_supported: true, client_id_metadata_document_supported: !options.legacy,
    })
    if (url.pathname === '/register') return Response.json({ ...JSON.parse(String(init?.body)), client_id: 'registered-client' }, { status: 201 })
    if (url.pathname === '/token') {
      const form = new URLSearchParams(String(init?.body)); tokenRequests.push(form)
      if (options.tokenError) return Response.json({ error: options.tokenError }, { status: options.tokenError === 'server_error' ? 503 : 400 })
      return Response.json({ access_token: 'fixture-access', token_type: 'Bearer', expires_in: 3600, refresh_token: 'rotated-refresh' })
    }
    if (url.pathname === '/revoke') { tokenRequests.push(new URLSearchParams(String(init?.body))); return new Response(null, { status: 200 }) }
    if (url.href === serverUrl) {
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fixture-access')
      if (!init?.body) return new Response(null, { status: 202 })
      const rpc = JSON.parse(String(init.body))
      rpcCalls.push(rpc.method)
      if (rpc.id === undefined) return new Response(null, { status: 202 })
      const result = rpc.method === 'initialize' ? { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'OAuth Fixture', version: '1' } }
        : rpc.method === 'tools/list' ? { tools: [{ name: 'get_note', description: 'Read the fixture note', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } }] }
          : { content: [{ type: 'text', text: 'fixture note result' }] }
      return Response.json({ jsonrpc: '2.0', id: rpc.id, result })
    }
    throw new Error(`Unexpected fixture URL: ${url.origin}${url.pathname}`)
  }
  const deps = { fetchFn,
    resolveAuthorizationURL: (async () => ({ hostname: 'auth.oauth.test', addresses: [] })) as unknown as Parameters<typeof startConnectorAuthorization>[3] extends infer T ? NonNullable<T>['resolveAuthorizationURL' & keyof NonNullable<T>] : never,
    discoverTools: (input: Parameters<typeof discoverRemoteConnectorTools>[0]) => discoverRemoteConnectorTools(input, undefined, fetchFn as never),
  }
  return { fetchFn, deps, tokenRequests, rpcCalls }
}
async function withCredentialKey(fn: () => Promise<void>) {
  const previous = process.env.AGENT_CREDENTIAL_KEY
  process.env.AGENT_CREDENTIAL_KEY = 'isolated-oauth-test-encryption-key-20261003'
  try { await fn() } finally {
    if (previous === undefined) delete process.env.AGENT_CREDENTIAL_KEY
    else process.env.AGENT_CREDENTIAL_KEY = previous
  }
}
async function connect(db: ReturnType<typeof database>, fixture: ReturnType<typeof authorizationServer>) {
  const started = await startConnectorAuthorization(db.client, userId, { name: 'Fixture', serverUrl }, fixture.deps)
  const authorization = new URL(started.authorizationUrl)
  const state = authorization.searchParams.get('state')!
  const row = db.tables.mcp_oauth_sessions[0]
  const saved = openOAuthState(String(row.secret_ciphertext), { userId, connectorId: `${started.connectorId}:${oauthStateHash(state)}`, serverUrl })
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(authorization.searchParams.get('code_challenge'), createHash('sha256').update(saved.verifier!).digest('base64url'))
  assert.equal(authorization.searchParams.get('resource'), serverUrl)
  assert.equal(started.attemptId, oauthStateHash(state))
  const callback = new URLSearchParams({ state, code: 'valid-code', iss: issuer })
  assert.equal(await finishConnectorAuthorization(db.client, callback, fixture.deps), started.connectorId)
  assert.equal(fixture.tokenRequests[0].get('code_verifier'), saved.verifier)
  await assert.rejects(finishConnectorAuthorization(db.client, callback, fixture.deps), /已过期或已使用/)
  return { row: db.tables.mcp_connectors[0] as OAuthConnectorRow, authorization }
}

test('OAuth completes PKCE, CIMD, durable single-use callback, actual MCP discovery and tool invocation', () => withCredentialKey(async () => {
  const db = database(), fixture = authorizationServer()
  const { row, authorization } = await connect(db, fixture)
  assert.equal(authorization.searchParams.get('client_id'), CONNECTOR_CLIENT_DOCUMENT)
  assert.equal(row.oauth_status, 'connected'); assert.equal(row.enabled, true)
  assert(!row.credential_ciphertext?.includes('fixture-access'))
  const connections = await loadRemoteConnectors(db.client, userId)
  const tools = remoteConnectorTools(connections, fixture.fetchFn as never)
  const result = await tools[0].execute({}, { supabase: db.client, userId } as unknown as ToolContext)
  assert.match(result.result, /fixture note result/)
  assert(fixture.rpcCalls.includes('tools/call'))
  assert(fixture.rpcCalls.includes('tools/list'))
}))

test('legacy dynamic registration remains supported alongside CIMD', () => withCredentialKey(async () => {
  const { authorization } = await connect(database(), authorizationServer({ legacy: true }))
  assert.equal(authorization.searchParams.get('client_id'), 'registered-client')
}))

test('issuer mismatch, expired authorization and callback replay cannot save a connection', () => withCredentialKey(async () => {
  for (const issue of ['issuer', 'expired']) {
    const db = database(), fixture = authorizationServer()
    const started = await startConnectorAuthorization(db.client, userId, { name: 'Fixture', serverUrl }, fixture.deps)
    const state = new URL(started.authorizationUrl).searchParams.get('state')!
    if (issue === 'expired') db.tables.mcp_oauth_sessions[0].expires_at = '2000-01-01T00:00:00Z'
    await assert.rejects(finishConnectorAuthorization(db.client, new URLSearchParams({ state, code: 'valid', iss: 'https://evil.test' }), fixture.deps))
    assert.equal(db.tables.mcp_connectors[0].enabled, false)
    assert.equal(fixture.tokenRequests.length, 0)
  }
}))

test('refresh rotates credentials, preserves connection on transient failure, and requires reauthorization on invalid_grant', () => withCredentialKey(async () => {
  for (const tokenError of [undefined, 'server_error', 'invalid_grant']) {
    const db = database(), first = authorizationServer()
    const { row } = await connect(db, first)
    const state = openOAuthState(row.credential_ciphertext!, connectorContext(row)); state.expiresAt = 0
    row.credential_ciphertext = sealOAuthState(state, connectorContext(row))
    const refresh = authorizationServer({ tokenError })
    if (tokenError) await assert.rejects(connectorAccessToken(db.client, row, refresh.fetchFn), tokenError === 'invalid_grant' ? /重新授权/ : /稍后重试/)
    else assert.equal(await connectorAccessToken(db.client, row, refresh.fetchFn), 'fixture-access')
    assert.equal(refresh.tokenRequests[0].get('grant_type'), 'refresh_token')
    assert.equal(row.oauth_status, tokenError === 'invalid_grant' ? 'reauth_required' : 'connected')
    assert.equal((row as unknown as Row).oauth_refresh_lease, null)
    if (!tokenError) assert.equal(openOAuthState(row.credential_ciphertext!, connectorContext(row)).tokens?.refresh_token, 'rotated-refresh')
  }
}))

test('revocation reports upstream capability accurately and sends the refresh credential only to its discovered endpoint', () => withCredentialKey(async () => {
  const db = database(), fixture = authorizationServer(), { row } = await connect(db, fixture)
  assert.equal(await revokeConnectorAuthorization(row, fixture.fetchFn), 'revoked')
  assert.equal(fixture.tokenRequests.at(-1)?.get('token'), 'rotated-refresh')
  assert.equal(await revokeConnectorAuthorization({ ...row, auth_type: 'none' }, fixture.fetchFn), 'unsupported')
  assert.equal(await revokeConnectorAuthorization(row, async () => new Response(null, { status: 503 })), 'failed')
}))

test('OAuth credentials are tenant-bound and issuer changes discard previously issued tokens and client identity', () => withCredentialKey(async () => {
  const state: ConnectorOAuthState = { type: 'mychat-mcp-oauth', version: 1, issuer, client: { client_id: 'old-client' }, tokens: { access_token: 'old-access', token_type: 'Bearer' } }
  const context = { userId, connectorId: 'test', serverUrl }
  const cipher = sealOAuthState(state, context)
  assert.throws(() => openOAuthState(cipher, { ...context, userId: 'other' }))
  assert.equal(parseOAuthState('plain-bearer'), null)
  assert.equal(parseOAuthState('{"type":"other","version":1}'), null)
  for (const url of ['http://x.test', 'https://a:b@x.test', 'https://x.test/#fragment']) assert.throws(() => httpsOAuthURL(url))
  const provider = new ConnectorOAuthProvider(state)
  provider.saveDiscoveryState({ authorizationServerUrl: 'https://new.test' })
  assert.equal(provider.value.client, undefined); assert.equal(provider.value.tokens, undefined)
  assert.throws(() => validateCallbackIssuer(provider.value, issuer))
  provider.invalidateCredentials('all'); assert.equal(provider.value.discovery, undefined)
}))

test('directory surfaces usable active HTTPS remotes and excludes templates, required headers and stdio packages', async () => {
  const row = (remotes: unknown[], status = 'active') => ({ server: { name: 'example/tool', description: 'description', remotes }, _meta: { 'io.modelcontextprotocol.registry/official': { status } } })
  const response = await searchConnectorDirectory('notes', undefined, async input => {
    assert.equal(new URL(String(input)).searchParams.get('search'), 'notes')
    return Response.json({ servers: [row([{ type: 'streamable-http', url: serverUrl }]),
      row([{ type: 'streamable-http', url: 'http://unsafe.test' }]), row([{ type: 'streamable-http', url: 'https://mcp.test/{id}' }]),
      row([{ type: 'streamable-http', url: serverUrl, headers: [{ name: 'x-key' }] }]), row([], 'deleted')], metadata: { nextCursor: 'page2' } })
  })
  assert.equal(response.entries.length, 1); assert.equal(response.entries[0].serverUrl, serverUrl)
  assert.equal(response.nextCursor, 'page2')
  await assert.rejects(searchConnectorDirectory('x'.repeat(121)), /查询过长/)
  await assert.rejects(searchConnectorDirectory('', undefined, async () => new Response(null, { status: 503 })), /暂时不可用/)
})
