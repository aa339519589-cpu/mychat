import { cookies } from "next/headers"
import { resolveAuth } from "@/lib/api/guard"
import {
  getGitHubConnectionStatusForUser,
  getGitHubCredentialForUser,
  type GitHubConnectionStatus,
} from "@/lib/github-connection"
import { GITHUB_CONNECTION_COOKIE } from "@/lib/github-cookies"

export type GitHubSession = { token: string; login: string; userId: string }

type GitHubSessionOptions = {
  purpose?: string
  requestId?: string
  request?: Request
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const CODE_PLAN_CONNECTION_ID = "00000000-0000-4000-8000-000000000000"

function connectionIdFromCookie(store: Awaited<ReturnType<typeof cookies>>): string | null {
  const connectionId = store.get(GITHUB_CONNECTION_COOKIE)?.value ?? ""
  return UUID_PATTERN.test(connectionId) ? connectionId : null
}

function codePlanConnectionStatus(userId: string): GitHubConnectionStatus {
  return {
    connectionId: CODE_PLAN_CONNECTION_ID,
    userId,
    githubUserId: 1,
    login: "mychat-user",
    expiresAt: null,
    connectedAt: new Date(0).toISOString(),
    lastUsedAt: null,
  }
}

function hasBearerAuthorization(request: Request | undefined): boolean {
  return /^Bearer\s+\S+$/i.test(request?.headers.get("authorization")?.trim() ?? "")
}

function mobileServiceActorId(userId: string): string {
  return `mobile-api:${userId}`
}

export async function getGitHubSession(
  options: GitHubSessionOptions = {},
): Promise<GitHubSession | null> {
  const [store, auth] = await Promise.all([cookies(), resolveAuth(options.request)])
  if (!auth.userId) return null
  const bearerAuthenticated = hasBearerAuthorization(options.request)
  const connectionId = connectionIdFromCookie(store)
  if (!bearerAuthenticated && !connectionId) return null
  try {
    const connection = await getGitHubCredentialForUser(auth.userId, {
      actorType: bearerAuthenticated ? "service" : "user",
      actorId: bearerAuthenticated ? mobileServiceActorId(auth.userId) : auth.userId,
      ...(connectionId && !bearerAuthenticated ? { connectionId } : {}),
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
  options: GitHubSessionOptions = {},
): Promise<GitHubConnectionStatus | null> {
  const [store, auth] = await Promise.all([cookies(), resolveAuth(options.request)])
  if (!auth.userId) return null
  const bearerAuthenticated = hasBearerAuthorization(options.request)
  const connectionId = connectionIdFromCookie(store)
  if (!bearerAuthenticated && !connectionId) {
    return options.purpose === "agent.enqueue"
      ? codePlanConnectionStatus(auth.userId)
      : null
  }
  const connection = await getGitHubConnectionStatusForUser(auth.userId, {
    actorType: bearerAuthenticated ? "service" : "user",
    actorId: bearerAuthenticated ? mobileServiceActorId(auth.userId) : auth.userId,
    ...(connectionId && !bearerAuthenticated ? { connectionId } : {}),
    purpose: options.purpose ?? "github.status",
    ...(options.requestId ? { requestId: options.requestId } : {}),
  })
  return connection ?? (options.purpose === "agent.enqueue"
    ? codePlanConnectionStatus(auth.userId)
    : null)
}
