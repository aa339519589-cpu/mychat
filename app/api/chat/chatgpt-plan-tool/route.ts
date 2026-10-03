import { NextRequest } from 'next/server'
import { enforceRequestRateLimit, resolveAuth } from '@/lib/api/guard'
import { readJson, requestErrorResponse } from '@/lib/api/request'
import { createAdminClient } from '@/lib/supabase/admin'
import { loadMemoryPreferences } from '@/lib/chat/authoritative-context-memory'
import { latestBeijingDateFromMessages } from '@/lib/chat/request-context'
import { activeTools, execTool, type ToolContext, type ToolDef } from '@/lib/tools'
import {
  loadRemoteConnectors,
  relevantRemoteConnectorTools,
  remoteConnectorOnDemandTools,
  remoteConnectorTools,
} from '@/lib/mcp/remote-connectors'
import type { SupabaseClient } from '@/lib/supabase/types'
import { isRecord } from '@/lib/unknown-value'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
type ToolRequestBody = {
  conversationId?: unknown
  userMessageId?: unknown
  privateChat?: unknown
  toolName?: unknown
  arguments?: unknown
  searchMode?: unknown
  connectorAccessMode?: unknown
  connectorIds?: unknown
  latestUserRequest?: unknown
}
type PlanToolContext = Omit<ToolContext, 'searchMode'> & {
  memoryEnabled: boolean
  searchMode: 'web' | 'off'
}

function response(body: object, status = 200): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
}

function validUUID(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value)
}

function selectedIDs(value: unknown): string[] | undefined {
  if (value === null || value === undefined) return undefined
  if (!Array.isArray(value) || value.length > 10 || value.some(id => !validUUID(id))) return []
  return [...new Set(value.map(id => String(id).toLowerCase()))]
}

function requestedTool(tools: ToolDef[], name: string): ToolDef | null {
  return tools.find(tool => tool.name === name) ?? null
}

async function executeOnDemandConnectorTool(
  tools: ToolDef[],
  toolContext: ToolContext,
  args: unknown,
): Promise<{ result: string; event?: object } | Response> {
  const search = requestedTool(tools, 'search_connector_tools')
  const call = requestedTool(tools, 'call_connector_tool')
  if (!search || !call || !isRecord(args) || typeof args.connectorId !== 'string'
    || typeof args.toolName !== 'string' || !isRecord(args.arguments)) {
    return response({ error: '按需连接器工具参数无效' }, 400)
  }
  const warmed = await search.execute({
    query: `${args.connectorId} ${args.toolName}`,
  }, toolContext)
  const encoded = warmed.result.slice(warmed.result.indexOf('\n') + 1)
  const matches = (() => {
    try { return JSON.parse(encoded) as unknown }
    catch { return [] }
  })()
  const authorized = Array.isArray(matches) && matches.some(item =>
    isRecord(item) && item.connectorId === args.connectorId && item.toolName === args.toolName,
  )
  if (!authorized) return response({ error: '先搜索并选择当前对话中匹配的连接器工具' }, 403)
  return call.execute(args, toolContext)
}

function validToolRequest(body: ToolRequestBody): boolean {
  return typeof body.privateChat === 'boolean' && typeof body.toolName === 'string'
    && Boolean(body.toolName.trim()) && body.toolName.length <= 128 && isRecord(body.arguments)
}

async function loadToolContext(input: {
  admin: SupabaseClient
  userId: string
  body: ToolRequestBody
  signal: AbortSignal
}): Promise<PlanToolContext | Response> {
  let projectId: string | null = null
  let memoryEnabled = false
  let sensitiveMemoryEnabled = false
  let latestDate: string | null = null
  if (!input.body.privateChat) {
    if (!validUUID(input.body.conversationId) || !validUUID(input.body.userMessageId)) {
      return response({ error: '工具调用缺少有效对话标识' }, 400)
    }
    const conversation = await input.admin.from('conversations')
      .select('id,project_id,memory_enabled').eq('id', input.body.conversationId)
      .eq('user_id', input.userId).maybeSingle()
    if (conversation.error) return response({ error: '对话权限暂时无法验证' }, 503)
    if (!conversation.data) return response({ error: '对话不存在或不属于当前账号' }, 404)
    const userMessage = await input.admin.from('messages').select('id,created_at,role')
      .eq('id', input.body.userMessageId).eq('conversation_id', input.body.conversationId)
      .eq('user_id', input.userId).maybeSingle()
    if (userMessage.error) return response({ error: '当前用户消息无法验证' }, 503)
    if (!userMessage.data || userMessage.data.role !== 'user') {
      return response({ error: '当前用户消息不存在或不属于此对话' }, 404)
    }
    projectId = typeof conversation.data.project_id === 'string' ? conversation.data.project_id : null
    try {
      const preferences = await loadMemoryPreferences(input.admin, input.userId)
      memoryEnabled = conversation.data.memory_enabled !== false && preferences.enabled
      sensitiveMemoryEnabled = preferences.sensitiveEnabled
    } catch {
      return response({ error: '记忆权限暂时无法验证，工具已中止' }, 503)
    }
    latestDate = latestBeijingDateFromMessages([{ ts: userMessage.data.created_at }])
  }
  return {
    supabase: input.admin,
    userId: input.userId,
    projectId,
    sensitiveMemoryEnabled,
    memoryEnabled,
    searchMode: input.body.searchMode === 'web' ? 'web' : 'off',
    latestBeijingDate: latestDate,
    signal: input.signal,
  }
}

async function createToolSet(input: {
  admin: SupabaseClient
  userId: string
  body: ToolRequestBody
  context: PlanToolContext
}): Promise<ToolDef[]> {
  const latestUserRequest = typeof input.body.latestUserRequest === 'string'
    ? input.body.latestUserRequest.slice(0, 8_000)
    : ''
  const connectors = input.body.privateChat ? [] : await loadRemoteConnectors(
    input.admin,
    input.userId,
    selectedIDs(input.body.connectorIds),
  )
  const connectorTools = input.body.connectorAccessMode === 'always_available'
    ? remoteConnectorTools(connectors)
    : input.body.connectorAccessMode === 'on_demand'
      ? remoteConnectorOnDemandTools(connectors)
      : relevantRemoteConnectorTools(connectors, latestUserRequest)
  const builtin = activeTools({
    loggedIn: true,
    searchMode: input.context.searchMode,
    memoryEnabled: input.context.memoryEnabled,
    projectId: input.context.projectId,
  })
  return input.body.connectorAccessMode === 'on_demand' && !input.body.privateChat
    ? [...builtin, ...remoteConnectorOnDemandTools(connectors)]
    : [...builtin, ...connectorTools]
}

async function runSelectedTool(input: {
  body: ToolRequestBody
  tools: ToolDef[]
  context: ToolContext
}): Promise<Response> {
  const selected = requestedTool(input.tools, input.body.toolName as string)
  if (!selected) return response({ error: '工具未启用或不属于当前对话' }, 403)
  try {
    const outcome = input.body.toolName === 'call_connector_tool'
      ? await executeOnDemandConnectorTool(input.tools, input.context, input.body.arguments)
      : await execTool(input.tools, input.body.toolName as string, input.body.arguments, input.context)
    if (outcome instanceof Response) return outcome
    return response({ result: outcome.result, event: outcome.event ?? null })
  } catch (error) {
    return response({ error: error instanceof Error ? error.message : '工具执行失败' }, 502)
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  const auth = await resolveAuth(request)
  if (auth.authUnavailable) return response({ error: '认证服务暂时不可用' }, 503)
  if (!auth.userId || !auth.supabase) return response({ error: '请先登录 MyChat' }, 401)
  const rate = await enforceRequestRateLimit(auth, request)
  if (rate.response) return rate.response
  let body: ToolRequestBody
  try { body = await readJson(request, { maxBytes: 256 * 1024 }) as ToolRequestBody }
  catch (error) { return requestErrorResponse(error) }
  if (!validToolRequest(body)) {
    return response({ error: 'ChatGPT 套餐工具调用请求无效' }, 400)
  }

  const admin = createAdminClient()
  if (!admin) return response({ error: '工具服务暂时不可用' }, 503)
  const client = admin as unknown as SupabaseClient
  const context = await loadToolContext({ admin: client, userId: auth.userId, body, signal: request.signal })
  if (context instanceof Response) return context
  const tools = await createToolSet({ admin: client, userId: auth.userId, body, context })
  return runSelectedTool({ body, tools, context })
}
