import { cookies } from "next/headers"
import { resolveAuth } from "@/lib/api/guard"
import {
  getGitHubConnectionStatusForUser,
  getGitHubCredentialForUser,
  type GitHubConnectionStatus,
} from "@/lib/github-connection"
import { GITHUB_CONNECTION_COOKIE } from "@/lib/github-cookies"

export type GitHubSession = { token: string; login: string; userId: string }

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function connectionIdFromCookie(store: Awaited<ReturnType<typeof cookies>>): string | null {
  const connectionId = store.get(GITHUB_CONNECTION_COOKIE)?.value ?? ""
  return UUID_PATTERN.test(connectionId) ? connectionId : null
}

export async function getGitHubSession(
  options: { purpose?: string; requestId?: string } = {},
): Promise<GitHubSession | null> {
  const [store, auth] = await Promise.all([cookies(), resolveAuth()])
  if (!auth.userId) return null
  const connectionId = connectionIdFromCookie(store)
  if (!connectionId) return null
  try {
    const connection = await getGitHubCredentialForUser(auth.userId, {
      actorType: "user",
      actorId: auth.userId,
      connectionId,
      purpose: options.purpose ?? "github.session",
      ...(options.requestId ? { requestId: options.requestId } : {}),
    })
    return connection
      ? { token: connection.token, login: connection.login, userId: auth.userId }
      : null
  } catch {
    // Existing callers treat an unreadable, expired, or unavailable credential
    // as disconnected. Explicit worker access uses getGitHubCredentialForUser
    // directly and receives typed failures for retry/reconnect decisions.
    return null
  }
}

export async function getCurrentGitHubConnectionStatus(
  options: { purpose?: string; requestId?: string } = {},
): Promise<GitHubConnectionStatus | null> {
  const [store, auth] = await Promise.all([cookies(), resolveAuth()])
  if (!auth.userId) return null
  const connectionId = connectionIdFromCookie(store)
  if (!connectionId) return null
  return getGitHubConnectionStatusForUser(auth.userId, {
    actorType: "user",
    actorId: auth.userId,
    connectionId,
    purpose: options.purpose ?? "github.status",
    ...(options.requestId ? { requestId: options.requestId } : {}),
  })
}
