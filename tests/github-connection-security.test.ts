import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import {
  getGitHubConnectionStatusForUser,
  getGitHubCredentialForUser,
  GitHubConnectionError,
  persistGitHubConnection,
  type GitHubConnectionRpcClient,
} from '../lib/github-connection'
import { openGitHubCredential, sealGitHubCredential } from '../lib/github-credential'
import { createGitHubOAuthState, verifyGitHubOAuthState } from '../lib/github-oauth-state'
import { revokeGitHubOAuthToken } from '../lib/github-token-revocation'

const SECRET = 'test-github-credential-secret-with-at-least-32-characters'
const USER_A = '11111111-1111-4111-8111-111111111111'
const USER_B = '22222222-2222-4222-8222-222222222222'
const CONNECTION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const TOKEN = 'synthetic-github-oauth-token-that-must-never-reach-a-cookie-or-database'

type RpcResult = { data: unknown; error: null | { message: string } }

function rpcClient(
  implementation: (name: string, args: Record<string, unknown>) => Promise<RpcResult>,
): GitHubConnectionRpcClient {
  return { rpc: implementation } as unknown as GitHubConnectionRpcClient
}

function withCredentialSecret(t: test.TestContext): void {
  const previous = process.env.AGENT_CREDENTIAL_KEY
  process.env.AGENT_CREDENTIAL_KEY = SECRET
  t.after(() => {
    if (previous === undefined) delete process.env.AGENT_CREDENTIAL_KEY
    else process.env.AGENT_CREDENTIAL_KEY = previous
  })
}

test('GitHub credentials are encrypted before persistence and AAD-bound to user/login', { concurrency: false }, async t => {
  withCredentialSecret(t)
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  const client = rpcClient(async (name, args) => {
    calls.push({ name, args })
    return { data: CONNECTION_ID, error: null }
  })

  const persisted = await persistGitHubConnection({
    userId: USER_A,
    githubUserId: 12345,
    login: 'octocat',
    token: TOKEN,
    scopes: ['workflow', 'repo', 'repo'],
    expiresAt: new Date(Date.now() + 60_000),
    requestId: 'request-12345678',
  }, client)

  assert.deepEqual(persisted, { connectionId: CONNECTION_ID })
  const captured = calls[0]
  assert.ok(captured)
  assert.equal(captured.name, 'upsert_github_connection')
  assert.doesNotMatch(JSON.stringify(captured.args), new RegExp(TOKEN))
  const ciphertext = captured.args.input_credential_ciphertext
  assert.equal(typeof ciphertext, 'string')
  assert.match(ciphertext as string, /^github-credential:v1\./)
  assert.equal(openGitHubCredential(ciphertext as string, { userId: USER_A, login: 'octocat' }), TOKEN)
  assert.equal(openGitHubCredential(ciphertext as string, { userId: USER_B, login: 'octocat' }), null)
  assert.equal(openGitHubCredential(ciphertext as string, { userId: USER_A, login: 'other-user' }), null)
  assert.deepEqual(captured.args.input_scopes, ['repo', 'workflow'])
})

test('workers retrieve by explicit user id and user access additionally requires the opaque connection id', { concurrency: false }, async t => {
  withCredentialSecret(t)
  const ciphertext = sealGitHubCredential(TOKEN, { userId: USER_A, login: 'octocat' })
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  const client = rpcClient(async (name, args) => {
    calls.push({ name, args })
    return {
      data: [{
        connection_id: CONNECTION_ID,
        user_id: USER_A,
        github_user_id: 12345,
        login: 'octocat',
        credential_ciphertext: ciphertext,
        scopes: ['repo'],
        expires_at: null,
      }],
      error: null,
    }
  })

  const connection = await getGitHubCredentialForUser(USER_A, {
    actorType: 'worker',
    actorId: 'worker-us-central-1-7',
    purpose: 'agent.publish',
    requestId: 'request-abcdefgh',
  }, client)
  assert.equal(connection?.token, TOKEN)
  assert.deepEqual(calls[0], {
    name: 'read_github_connection',
    args: {
      input_user_id: USER_A,
      input_connection_id: null,
      input_actor_type: 'worker',
      input_actor_id: 'worker-us-central-1-7',
      input_purpose: 'agent.publish',
      input_request_id: 'request-abcdefgh',
    },
  })

  await assert.rejects(
    getGitHubCredentialForUser(USER_A, {
      actorType: 'user',
      actorId: USER_A,
      purpose: 'github.repos',
    }, client),
    (error: unknown) => error instanceof GitHubConnectionError && error.code === 'invalid_input',
  )
  assert.equal(calls.length, 1, 'invalid browser binding must fail before the RPC')
})

test('credential and status reads fail closed when encryption is not configured', { concurrency: false }, async t => {
  const previous = process.env.AGENT_CREDENTIAL_KEY
  delete process.env.AGENT_CREDENTIAL_KEY
  t.after(() => {
    if (previous === undefined) delete process.env.AGENT_CREDENTIAL_KEY
    else process.env.AGENT_CREDENTIAL_KEY = previous
  })
  let calls = 0
  const client = rpcClient(async () => {
    calls += 1
    return { data: null, error: null }
  })
  const access = {
    actorType: 'user' as const,
    actorId: USER_A,
    connectionId: CONNECTION_ID,
    purpose: 'github.status',
  }

  await assert.rejects(
    getGitHubCredentialForUser(USER_A, access, client),
    (error: unknown) => error instanceof GitHubConnectionError && error.code === 'encryption_unconfigured',
  )
  await assert.rejects(
    getGitHubConnectionStatusForUser(USER_A, access, client),
    (error: unknown) => error instanceof GitHubConnectionError && error.code === 'encryption_unconfigured',
  )
  assert.equal(calls, 0)
})

test('OAuth state is opaque, integrity-protected, and bound to the Supabase user', () => {
  const state = createGitHubOAuthState(USER_A, 'github-client-secret')
  assert.match(state, /^[A-Za-z0-9_-]{32}\.[A-Za-z0-9_-]{43}$/)
  assert.doesNotMatch(state, new RegExp(USER_A))
  assert.equal(verifyGitHubOAuthState(state, USER_A, 'github-client-secret'), true)
  assert.equal(verifyGitHubOAuthState(state, USER_B, 'github-client-secret'), false)
  assert.equal(verifyGitHubOAuthState(`${state.slice(0, -1)}x`, USER_A, 'github-client-secret'), false)
})

test('disconnect revokes exactly one GitHub OAuth token with app-owner authentication', async () => {
  let seenUrl = ''
  let seenInit: RequestInit | undefined
  const fakeFetch: typeof fetch = async (input, init) => {
    seenUrl = String(input)
    seenInit = init
    return new Response(null, { status: 204 })
  }
  const revoked = await revokeGitHubOAuthToken(TOKEN, {
    clientId: 'client-id',
    clientSecret: 'client-secret',
  }, fakeFetch)

  assert.equal(revoked, true)
  assert.equal(seenUrl, 'https://api.github.com/applications/client-id/token')
  assert.equal(seenInit?.method, 'DELETE')
  assert.deepEqual(JSON.parse(String(seenInit?.body)), { access_token: TOKEN })
  assert.match(String((seenInit?.headers as Record<string, string>).Authorization), /^Basic /)
})

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? sourceFiles(path) : entry.isFile() && /\.(ts|tsx)$/.test(entry.name) ? [path] : []
  })
}

test('API routes never read or write a raw GitHub token cookie', () => {
  const apiSource = sourceFiles(join(process.cwd(), 'app', 'api'))
    .map(path => readFileSync(path, 'utf8'))
    .join('\n')
  assert.doesNotMatch(apiSource, /(?:cookies\(\)|\.cookies)\s*\.get\(["']gh_access_token["']\)/)
  assert.doesNotMatch(apiSource, /Set-Cookie[^\n]*(?:accessToken|gh_access_token=\$\{)/)

  const callback = readFileSync(join(process.cwd(), 'app/api/auth/github/callback/route.ts'), 'utf8')
  assert.match(callback, /appendGitHubConnectionCookie/)
  assert.doesNotMatch(callback, /gh_login|gh_user_id|gh_access_token/)
})

test('GitHub connection migration enforces service-role-only audited and expiring access', () => {
  const migration = readFileSync(
    join(process.cwd(), 'supabase/migrations/20260713080000_github_connections.sql'),
    'utf8',
  )
  assert.match(migration, /create table if not exists public\.github_connections/)
  assert.match(migration, /credential_ciphertext ~ '\^github-credential:v1/)
  assert.match(migration, /expires_at is null or expires_at > connected_at/)
  assert.match(migration, /alter table public\.github_connections enable row level security/)
  assert.match(migration, /revoke all on table public\.github_connections from public, anon, authenticated, service_role/)
  assert.doesNotMatch(migration, /grant\s+(?:select|insert|update|delete|all)[^;]*github_connections[^;]*to\s+(?:anon|authenticated|service_role)/i)
  assert.match(migration, /grant execute on function public\.read_github_connection[\s\S]*?to service_role/)
  assert.match(migration, /input_actor_type = 'user'[\s\S]*?input_connection_id is null/)
  assert.match(migration, /'github\.credential\.accessed'/)
  assert.match(migration, /insert into public\.audit_log\([\s\S]*?principal_id, actor_type, actor_id, action, resource_type/)
  assert.match(migration, /to_regclass\('public\.audit_log'\) is null/)
  assert.match(migration, /input_purpose <> 'github\.disconnect'/)
})
