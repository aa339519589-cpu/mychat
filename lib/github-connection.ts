import type { SupabaseClient } from '@/lib/supabase/types'
import {
  githubCredentialEncryptionConfigured,
  openGitHubCredential,
  sealGitHubCredential,
} from '@/lib/github-credential'
import { createAdminClient } from '@/lib/supabase/admin'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,98}[A-Za-z0-9])?$/
const PURPOSE_PATTERN = /^[a-z][a-z0-9_.-]{1,99}$/

export type GitHubCredentialActorType = 'user' | 'service' | 'worker' | 'system'

export type GitHubCredentialAccess = {
  actorType: GitHubCredentialActorType
  actorId: string
  purpose: string
  requestId?: string
  /** Required for browser/user access; workers address the connection by userId. */
  connectionId?: string
}

export type GitHubConnection = {
  connectionId: string
  userId: string
  githubUserId: number
  login: string
  token: string
  scopes: string[]
  expiresAt: string | null
}

export type GitHubConnectionStatus = Omit<GitHubConnection, 'token' | 'scopes'> & {
  connectedAt: string
  lastUsedAt: string | null
}

export type PersistGitHubConnectionInput = {
  userId: string
  githubUserId: number
  login: string
  token: string
  scopes?: string[]
  expiresAt?: Date | null
  requestId?: string
}

export type GitHubConnectionRpcClient = Pick<SupabaseClient, 'rpc'>

type CredentialRow = {
  connection_id: string
  user_id: string
  github_user_id: number
  login: string
  credential_ciphertext: string
  scopes: string[]
  expires_at: string | null
}

type StatusRow = Omit<CredentialRow, 'credential_ciphertext' | 'scopes'> & {
  connected_at: string
  last_used_at: string | null
}

export class GitHubConnectionError extends Error {
  constructor(
    public readonly code:
      | 'invalid_input'
      | 'encryption_unconfigured'
      | 'store_unavailable'
      | 'credential_unreadable',
  ) {
    const messages = {
      invalid_input: 'GitHub 连接参数无效',
      encryption_unconfigured: 'GitHub 凭据加密未配置',
      store_unavailable: 'GitHub 连接存储暂时不可用',
      credential_unreadable: 'GitHub 凭据无法解密，请重新连接',
    } as const
    super(messages[code])
    this.name = 'GitHubConnectionError'
  }
}

function adminClient(override?: GitHubConnectionRpcClient | null): GitHubConnectionRpcClient {
  const client = override === undefined ? createAdminClient() : override
  if (!client) throw new GitHubConnectionError('store_unavailable')
  return client
}

function firstRow(value: unknown): Record<string, unknown> | null {
  const candidate = Array.isArray(value) ? value[0] : value
  return candidate && typeof candidate === 'object' && !Array.isArray(candidate)
    ? candidate as Record<string, unknown>
    : null
}

function validUuid(value: string): boolean {
  return UUID_PATTERN.test(value)
}

function validLogin(value: string): boolean {
  return value.length <= 100 && LOGIN_PATTERN.test(value)
}

function validTimestamp(value: string): boolean {
  return value.length <= 64 && Number.isFinite(Date.parse(value))
}

function validScopeArray(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.length <= 64
    && value.every(scope => typeof scope === 'string'
      && scope.length <= 100
      && /^[A-Za-z0-9:_-]+$/.test(scope))
}

function normalizedScopes(value: string[] | undefined): string[] {
  if (!value) return []
  const scopes = [...new Set(value.map(scope => scope.trim()).filter(Boolean))]
  if (scopes.length > 64 || scopes.some(scope => scope.length > 100 || !/^[A-Za-z0-9:_-]+$/.test(scope))) {
    throw new GitHubConnectionError('invalid_input')
  }
  return scopes.sort()
}

function validateAccess(userId: string, access: GitHubCredentialAccess): void {
  if (!validUuid(userId)
    || !access.actorId.trim()
    || access.actorId.length > 200
    || !PURPOSE_PATTERN.test(access.purpose)
    || (access.requestId !== undefined && access.requestId.length > 200)
    || (access.connectionId !== undefined && !validUuid(access.connectionId))) {
    throw new GitHubConnectionError('invalid_input')
  }
  if (access.actorType === 'user'
    && (access.actorId !== userId || !access.connectionId)) {
    throw new GitHubConnectionError('invalid_input')
  }
}

function parseCredentialRow(value: unknown, expectedUserId: string): CredentialRow | null {
  const row = firstRow(value)
  if (!row) return null
  if (typeof row.connection_id !== 'string'
    || !validUuid(row.connection_id)
    || row.user_id !== expectedUserId
    || typeof row.github_user_id !== 'number'
    || !Number.isSafeInteger(row.github_user_id)
    || row.github_user_id <= 0
    || typeof row.login !== 'string'
    || !validLogin(row.login)
    || typeof row.credential_ciphertext !== 'string'
    || row.credential_ciphertext.length > 16_384
    || !row.credential_ciphertext.startsWith('github-credential:v1.')
    || !validScopeArray(row.scopes)
    || (row.expires_at !== null
      && (typeof row.expires_at !== 'string' || !validTimestamp(row.expires_at)))) {
    throw new GitHubConnectionError('credential_unreadable')
  }
  return row as unknown as CredentialRow
}

function parseStatusRow(value: unknown, expectedUserId: string): StatusRow | null {
  const row = firstRow(value)
  if (!row) return null
  if (typeof row.connection_id !== 'string'
    || !validUuid(row.connection_id)
    || row.user_id !== expectedUserId
    || typeof row.github_user_id !== 'number'
    || !Number.isSafeInteger(row.github_user_id)
    || row.github_user_id <= 0
    || typeof row.login !== 'string'
    || !validLogin(row.login)
    || typeof row.connected_at !== 'string'
    || !validTimestamp(row.connected_at)
    || (row.last_used_at !== null
      && (typeof row.last_used_at !== 'string' || !validTimestamp(row.last_used_at)))
    || (row.expires_at !== null
      && (typeof row.expires_at !== 'string' || !validTimestamp(row.expires_at)))) {
    throw new GitHubConnectionError('credential_unreadable')
  }
  return row as unknown as StatusRow
}

function parseRpcUuid(value: unknown): string {
  const candidate = Array.isArray(value) ? value[0] : value
  if (typeof candidate !== 'string' || !validUuid(candidate)) {
    throw new GitHubConnectionError('store_unavailable')
  }
  return candidate
}

function ensureEncryptionConfigured(): void {
  if (!githubCredentialEncryptionConfigured()) {
    throw new GitHubConnectionError('encryption_unconfigured')
  }
}

/**
 * Encrypt and persist a connection. The plaintext token is only supplied to
 * this server-only function and is never sent to Supabase or a browser.
 */
export async function persistGitHubConnection(
  input: PersistGitHubConnectionInput,
  clientOverride?: GitHubConnectionRpcClient | null,
): Promise<{ connectionId: string }> {
  ensureEncryptionConfigured()
  if (!validUuid(input.userId)
    || !Number.isSafeInteger(input.githubUserId)
    || input.githubUserId <= 0
    || !validLogin(input.login)
    || !input.token
    || input.token.length > 16_384
    || (input.requestId !== undefined && input.requestId.length > 200)
    || (input.expiresAt !== undefined
      && input.expiresAt !== null
      && (!Number.isFinite(input.expiresAt.getTime()) || input.expiresAt.getTime() <= Date.now()))) {
    throw new GitHubConnectionError('invalid_input')
  }

  const scopes = normalizedScopes(input.scopes)
  const credentialCiphertext = sealGitHubCredential(input.token, {
    userId: input.userId,
    login: input.login,
  })
  const client = adminClient(clientOverride)
  const { data, error } = await client.rpc('upsert_github_connection', {
    input_user_id: input.userId,
    input_github_user_id: input.githubUserId,
    input_login: input.login,
    input_credential_ciphertext: credentialCiphertext,
    input_scopes: scopes,
    input_expires_at: input.expiresAt?.toISOString() ?? null,
    input_actor_id: input.userId,
    input_request_id: input.requestId ?? null,
  })
  if (error) throw new GitHubConnectionError('store_unavailable')
  return { connectionId: parseRpcUuid(data) }
}

/**
 * Retrieve and audit a GitHub credential by its Supabase owner. Workers must
 * pass their own actor identity; browser/user calls must also bind the opaque
 * connection id from the HttpOnly cookie.
 */
export async function getGitHubCredentialForUser(
  userId: string,
  access: GitHubCredentialAccess,
  clientOverride?: GitHubConnectionRpcClient | null,
): Promise<GitHubConnection | null> {
  ensureEncryptionConfigured()
  validateAccess(userId, access)
  const client = adminClient(clientOverride)
  const { data, error } = await client.rpc('read_github_connection', {
    input_user_id: userId,
    input_connection_id: access.connectionId ?? null,
    input_actor_type: access.actorType,
    input_actor_id: access.actorId,
    input_purpose: access.purpose,
    input_request_id: access.requestId ?? null,
  })
  if (error) throw new GitHubConnectionError('store_unavailable')
  const row = parseCredentialRow(data, userId)
  if (!row) return null
  if (row.expires_at !== null
    && Date.parse(row.expires_at) <= Date.now()
    && access.purpose !== 'github.disconnect') return null
  const token = openGitHubCredential(row.credential_ciphertext, {
    userId,
    login: row.login,
  })
  if (token === null || !token || token.length > 16_384) {
    throw new GitHubConnectionError('credential_unreadable')
  }
  return {
    connectionId: row.connection_id,
    userId,
    githubUserId: row.github_user_id,
    login: row.login,
    token,
    scopes: row.scopes,
    expiresAt: row.expires_at,
  }
}

/** Metadata-only lookup; encrypted credential material never leaves Postgres. */
export async function getGitHubConnectionStatusForUser(
  userId: string,
  access: GitHubCredentialAccess,
  clientOverride?: GitHubConnectionRpcClient | null,
): Promise<GitHubConnectionStatus | null> {
  ensureEncryptionConfigured()
  validateAccess(userId, access)
  const client = adminClient(clientOverride)
  const { data, error } = await client.rpc('github_connection_status', {
    input_user_id: userId,
    input_connection_id: access.connectionId ?? null,
    input_actor_type: access.actorType,
    input_actor_id: access.actorId,
    input_purpose: access.purpose,
    input_request_id: access.requestId ?? null,
  })
  if (error) throw new GitHubConnectionError('store_unavailable')
  const row = parseStatusRow(data, userId)
  if (!row) return null
  if (row.expires_at !== null && Date.parse(row.expires_at) <= Date.now()) return null
  return {
    connectionId: row.connection_id,
    userId,
    githubUserId: row.github_user_id,
    login: row.login,
    expiresAt: row.expires_at,
    connectedAt: row.connected_at,
    lastUsedAt: row.last_used_at,
  }
}

export async function disconnectGitHubConnection(
  userId: string,
  options: { connectionId?: string; requestId?: string } = {},
  clientOverride?: GitHubConnectionRpcClient | null,
): Promise<boolean> {
  if (!validUuid(userId)
    || (options.connectionId !== undefined && !validUuid(options.connectionId))
    || (options.requestId !== undefined && options.requestId.length > 200)) {
    throw new GitHubConnectionError('invalid_input')
  }
  const client = adminClient(clientOverride)
  const { data, error } = await client.rpc('delete_github_connection', {
    input_user_id: userId,
    input_connection_id: options.connectionId ?? null,
    input_actor_id: userId,
    input_request_id: options.requestId ?? null,
  })
  if (error || typeof data !== 'boolean') throw new GitHubConnectionError('store_unavailable')
  return data
}
