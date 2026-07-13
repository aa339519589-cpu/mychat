import { readJson, requestErrorResponse } from '@/lib/api/request'
import { applyCodeChanges } from '@/lib/code-agent/apply'
import { parseCodeApplyRequest } from '@/lib/code-agent/apply-request'
import { getGitHubSession } from '@/lib/github-session'

// Transport adapter only: authenticate, bound/read JSON, validate, then delegate.
export async function POST(req: Request) {
  let raw: unknown
  try {
    raw = await readJson(req, { maxBytes: 2 * 1024 * 1024 })
  } catch (error) {
    return requestErrorResponse(error)
  }

  let input
  try {
    input = parseCodeApplyRequest(raw)
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : '请求参数无效' }, { status: 400 })
  }

  const githubSession = await getGitHubSession()
  if (!githubSession) {
    return Response.json({ error: '未连接 GitHub 或账号会话已变化' }, { status: 401 })
  }

  const outcome = await applyCodeChanges(input, githubSession.token)
  return Response.json(outcome.body, { status: outcome.status })
}
