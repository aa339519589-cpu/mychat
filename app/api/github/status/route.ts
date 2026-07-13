import { NextRequest } from 'next/server'
import { requestId } from '@/lib/api/request'
import { appendLegacyGitHubCookieCleanup } from '@/lib/github-cookies'
import { getCurrentGitHubConnectionStatus } from '@/lib/github-session'

function json(body: unknown, status = 200): Response {
  const headers = new Headers({
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  })
  // Erase credentials issued by pre-migration releases as soon as the normal
  // connection-status probe reaches a migrated instance.
  appendLegacyGitHubCookieCleanup(headers)
  return new Response(JSON.stringify(body), { status, headers })
}

// 前端用来判断当前用户是否已连接 GitHub
export async function GET(req: NextRequest) {
  try {
    const connection = await getCurrentGitHubConnectionStatus({
      purpose: 'github.status',
      requestId: requestId(req),
    })
    return json({ connected: !!connection, login: connection?.login || null })
  } catch {
    return json({ error: 'GitHub 连接服务暂时不可用' }, 503)
  }
}
