import { NextRequest } from 'next/server'
import { enforceLimits, resolveAuth } from '@/lib/api/guard'
import { readJson, requestErrorResponse } from '@/lib/api/request'
import { TIER_MAP, type Tier } from '@/lib/chat-data'
import { parseCodeChatRequest } from '@/lib/code-agent/request'
import { createCodeAgentStream } from '@/lib/code-agent/stream'
import { prepareCodeRun } from '@/lib/code-agent/task-context'
import { getGitHubSession } from '@/lib/github-session'

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY ?? ''
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com'
const TAVILY_API_KEY = process.env.TAVILY_API_KEY ?? ''

export async function POST(req: NextRequest) {
  let rawBody: unknown
  try {
    rawBody = await readJson(req, { maxBytes: 4 * 1024 * 1024 })
  } catch (error) {
    return requestErrorResponse(error)
  }

  let body
  try {
    body = parseCodeChatRequest(rawBody)
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : '请求参数无效' }, { status: 400 })
  }

  if (!DEEPSEEK_API_KEY) {
    return Response.json({ error: '服务未配置（DEEPSEEK_API_KEY 未设置）' }, { status: 500 })
  }

  const githubSession = await getGitHubSession()
  if (!githubSession) return Response.json({ error: '未连接 GitHub 或账号会话已变化' }, { status: 401 })

  const selectedTier = body.tier === '观照'
    ? TIER_MAP['正构']
    : (TIER_MAP[body.tier as Tier] ?? TIER_MAP['正构'])
  const auth = await resolveAuth()
  const gate = await enforceLimits(auth, req)
  if (gate.response) return gate.response

  const preparation = await prepareCodeRun(req, body, auth, githubSession)
  if (preparation.response) return preparation.response

  return createCodeAgentStream({
    req,
    body,
    run: preparation.context,
    apiKey: DEEPSEEK_API_KEY,
    baseUrl: DEEPSEEK_BASE_URL,
    tavilyApiKey: TAVILY_API_KEY,
    model: selectedTier.model,
    thinking: selectedTier.thinking,
    usingBalance: gate.usingBalance,
  })
}
