import { NextRequest } from 'next/server'
import { resolveAuth } from '@/lib/api/guard'
import { requestId } from '@/lib/api/request'
import {
  disconnectGitHubConnection,
  getGitHubCredentialForUser,
} from '@/lib/github-connection'
import {
  appendGitHubCookieCleanup,
  appendLegacyGitHubCookieCleanup,
  GITHUB_CONNECTION_COOKIE,
} from '@/lib/github-cookies'
import { revokeGitHubOAuthToken } from '@/lib/github-token-revocation'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function json(body: unknown, status: number, clearAll = false): Response {
  const headers = new Headers({
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  })
  if (clearAll) appendGitHubCookieCleanup(headers)
  else appendLegacyGitHubCookieCleanup(headers)
  return new Response(JSON.stringify(body), { status, headers })
}

// Revoke the upstream OAuth token first, then conditionally delete the exact
// persisted connection. A failed revocation remains retryable and is not
// falsely reported as disconnected.
export async function POST(req: NextRequest) {
  const auth = await resolveAuth()
  if (!auth.userId) return json({ error: '请先登录 MyChat' }, 401)

  const rawConnectionId = req.cookies.get(GITHUB_CONNECTION_COOKIE)?.value ?? ''
  const connectionId = UUID_PATTERN.test(rawConnectionId) ? rawConnectionId : undefined
  const traceId = requestId(req)

  try {
    const connection = await getGitHubCredentialForUser(auth.userId, connectionId
      ? {
          actorType: 'user',
          actorId: auth.userId,
          connectionId,
          purpose: 'github.disconnect',
          requestId: traceId,
        }
      : {
          actorType: 'service',
          actorId: 'api.github.disconnect',
          purpose: 'github.disconnect',
          requestId: traceId,
        })

    if (!connection) {
      await disconnectGitHubConnection(auth.userId, { connectionId, requestId: traceId })
      return json({ ok: true }, 200, true)
    }

    const revoked = await revokeGitHubOAuthToken(connection.token)
    if (!revoked) {
      return json({ error: 'GitHub 撤销暂时失败，请重试' }, 502)
    }

    await disconnectGitHubConnection(auth.userId, {
      connectionId: connection.connectionId,
      requestId: traceId,
    })
    return json({ ok: true }, 200, true)
  } catch {
    return json({ error: 'GitHub 连接服务暂时不可用，请重试' }, 503)
  }
}
