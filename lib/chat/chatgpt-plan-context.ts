import { isSafeExternalHttpUrl } from '@/lib/external-url'
import { loadAuthoritativeChatContext } from '@/lib/chat/authoritative-context'
import { loadCustomSystemPrompt } from '@/lib/chat/user-system-prompt'
import { prepareChatHistory } from '@/lib/chat/history'
import { appendUserSystemPrompt, latestBeijingDateFromMessages } from '@/lib/chat/request-context'
import { buildSystem } from '@/lib/llm/system'
import { activeTools } from '@/lib/tools'
import { ensureChatGPTPlanHistoryUserMessage } from '@/lib/chat/chatgpt-plan-history'
import type { SupabaseServer } from '@/lib/api/guard'
import type { SupabaseClient } from '@/lib/supabase/types'
import {
  loadRemoteConnectors,
  relevantRemoteConnectorTools,
  remoteConnectorOnDemandTools,
  remoteConnectorTools,
} from '@/lib/mcp/remote-connectors'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type PlanContextBody = {
  conversationId?: unknown
  userMessageId?: unknown
  createConversation?: unknown
  privateChat?: unknown
  title?: unknown
  projectId?: unknown
  memoryEnabled?: unknown
  content?: unknown
  images?: unknown
  hasAttachments?: unknown
  createdAt?: unknown
  modelName?: unknown
  searchMode?: unknown
  historyRetrievalEnabled?: unknown
  renderEnabled?: unknown
  connectorAccessMode?: unknown
  connectorIds?: unknown
}

export function planResponse(body: object, status = 200): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
}

export function planStringValue(value: unknown, max: number): string | null {
  if (typeof value !== 'string' || value.length > max || /[\u0000]/.test(value)) return null
  return value.trim()
}

export function validPlanUUID(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value)
}

export function safePlanImageRefs(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((item): item is string =>
    typeof item === 'string' && isSafeExternalHttpUrl(item),
  ))].slice(0, 16)
}

export function planConnectorIDs(value: unknown): string[] | undefined {
  if (value === null || value === undefined) return undefined
  if (!Array.isArray(value) || value.length > 10 || value.some(id => !validPlanUUID(id))) return []
  return [...new Set(value.map(id => String(id).toLowerCase()))]
}

export function responseTools<T extends { name: string; description: string; schema: unknown }>(tools: T[]) {
  return tools.map(tool => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.schema,
    strict: false,
  }))
}

export async function ensurePlanConversation(input: {
  client: SupabaseClient
  userId: string
  body: PlanContextBody
  conversationId: string
}): Promise<{ projectId: string | null; memoryEnabled: boolean } | Response> {
  const found = await input.client.from('conversations')
    .select('id,project_id,memory_enabled')
    .eq('id', input.conversationId).eq('user_id', input.userId).maybeSingle()
  if (found.error) return planResponse({ error: '对话上下文暂时不可用' }, 503)
  if (found.data) {
    return {
      projectId: typeof found.data.project_id === 'string' ? found.data.project_id : null,
      memoryEnabled: found.data.memory_enabled !== false,
    }
  }
  if (input.body.createConversation !== true) {
    return planResponse({ error: '对话不存在或不属于当前账号' }, 404)
  }

  const title = planStringValue(input.body.title, 160)
  const projectId = input.body.projectId === null || input.body.projectId === undefined
    ? null
    : validPlanUUID(input.body.projectId) ? input.body.projectId.toLowerCase() : ''
  if (!title || projectId === '') return planResponse({ error: '新对话信息无效' }, 400)
  if (projectId) {
    const project = await input.client.from('projects').select('id').eq('id', projectId)
      .eq('user_id', input.userId).maybeSingle()
    if (project.error) return planResponse({ error: '项目上下文暂时不可用' }, 503)
    if (!project.data) return planResponse({ error: '项目不存在或不属于当前账号' }, 404)
  }
  const memoryEnabled = input.body.memoryEnabled !== false
  const inserted = await input.client.from('conversations').insert({
    id: input.conversationId,
    user_id: input.userId,
    title,
    project_id: projectId,
    memory_enabled: memoryEnabled,
  }).select('id,project_id,memory_enabled').single()
  if (inserted.error || !inserted.data) return planResponse({ error: '新对话保存失败，请重试' }, 503)
  return { projectId, memoryEnabled }
}

export async function ensurePlanCurrentMessages(input: {
  client: SupabaseClient
  userId: string
  conversationId: string
  userMessageId: string
  body: PlanContextBody
}): Promise<Response | null> {
  const current = validateCurrentPlanMessage(input.body)
  if (current instanceof Response) return current
  const createdAt = typeof input.body.createdAt === 'string' && Number.isFinite(Date.parse(input.body.createdAt))
    ? new Date(input.body.createdAt).toISOString()
    : new Date().toISOString()
  const persisted = await ensureChatGPTPlanHistoryUserMessage(
    input.client,
    input.userId,
    input.conversationId,
    {
      id: input.userMessageId,
      role: 'user',
      content: current.content,
      images: current.images,
      createdAt,
    },
  )
  if (persisted.kind === 'persisted') return null
  if (persisted.kind === 'conflict') return planResponse({ error: '用户消息 ID 已用于其他内容' }, 409)
  if (persisted.kind === 'not_found') return planResponse({ error: '对话不存在或不属于当前账号' }, 404)
  return planResponse({ error: '用户消息保存失败，请重试' }, 503)
}

function validateCurrentPlanMessage(body: PlanContextBody): { content: string; images: string[] } | Response {
  const content = planStringValue(body.content, 1_000_000)
  if (content === null) return planResponse({ error: '用户消息无效或过长' }, 400)
  const images = safePlanImageRefs(body.images)
  if (!content && body.hasAttachments !== true && images.length === 0) {
    return planResponse({ error: '消息内容不能为空' }, 400)
  }
  return { content, images }
}

export async function connectorToolsForPlanRequest(input: {
  client: SupabaseClient
  userId: string
  ids: string[] | undefined
  mode: unknown
  query: string
}) {
  const connectors = await loadRemoteConnectors(input.client, input.userId, input.ids)
  if (input.mode === 'always_available') return remoteConnectorTools(connectors)
  if (input.mode === 'on_demand') return remoteConnectorOnDemandTools(connectors)
  return relevantRemoteConnectorTools(connectors, input.query)
}

type StoredPlanContext = {
  projectId: string | null
  memoryEnabled: boolean
  messages: Awaited<ReturnType<typeof loadAuthoritativeChatContext>>['messages']
  memories: Awaited<ReturnType<typeof loadAuthoritativeChatContext>>['memories']
  sensitiveMemoryEnabled: boolean
  project?: Awaited<ReturnType<typeof loadAuthoritativeChatContext>>['project']
}

function emptyPlanContext(): StoredPlanContext {
  return {
    projectId: null,
    memoryEnabled: false,
    messages: [],
    memories: [],
    sensitiveMemoryEnabled: false,
  }
}

async function loadStoredPlanContext(input: {
  client: SupabaseClient
  userId: string
  conversationId: string
  userMessageId: string
  body: PlanContextBody
}): Promise<StoredPlanContext | Response> {
  const conversation = await ensurePlanConversation(input)
  if (conversation instanceof Response) return conversation
  const persistence = await ensurePlanCurrentMessages(input)
  if (persistence) return persistence
  try {
    const stored = await loadAuthoritativeChatContext({
      client: input.client,
      userId: input.userId,
      conversationId: input.conversationId,
      userMessageId: input.userMessageId,
    })
    return {
      ...stored,
      projectId: conversation.projectId,
      memoryEnabled: stored.memoryEnabled && conversation.memoryEnabled,
    }
  } catch (error) {
    return planResponse({
      error: error instanceof Error ? error.message : '对话上下文暂时不可用',
    }, 503)
  }
}

async function planHistory(input: {
  client: SupabaseClient
  userId: string
  conversationId: string
  body: PlanContextBody
  context: StoredPlanContext
  signal: AbortSignal
}) {
  if (input.body.privateChat || input.body.historyRetrievalEnabled !== true) {
    return { renderedContext: '', sources: undefined, query: undefined }
  }
  try {
    return await prepareChatHistory({
      supabase: input.client as unknown as SupabaseServer,
      userId: input.userId,
      conversationId: input.conversationId,
      messages: input.context.messages,
      projectId: input.context.projectId,
      tier: '衡简',
      historyRetrievalEnabled: true,
      customEndpoint: false,
      signal: input.signal,
    })
  } catch {
    throw new Error('历史检索服务暂时不可用')
  }
}

function historySearchEvent(history: Awaited<ReturnType<typeof planHistory>>) {
  return history.sources?.length ? {
    search: {
      kind: 'history',
      query: history.query ?? '',
      results: history.sources.map(source => ({
        title: source.conversationTitle?.trim() || '未命名聊天',
        url: `mychat://conversation/${encodeURIComponent(source.conversationId)}`,
        snippet: source.snippet,
        conversation_id: source.conversationId,
        message_start_id: source.messageStartId ?? undefined,
      })),
    },
  } : null
}

async function planSystemPrompt(input: {
  client: SupabaseClient
  userId: string
  body: PlanContextBody
  context: StoredPlanContext
  historyContext: string
}): Promise<string | Response> {
  let customPrompt: string
  try { customPrompt = await loadCustomSystemPrompt(input.client, input.userId) }
  catch { return planResponse({ error: '用户自定义系统提示词暂时无法加载' }, 503) }
  return appendUserSystemPrompt(buildSystem(
    input.context.memoryEnabled && !input.context.projectId ? input.context.memories : undefined,
    {
      searchMode: input.body.searchMode === 'web' ? 'web' : 'off',
      latestBeijingDate: latestBeijingDateFromMessages(input.context.messages),
      memoryEnabled: input.context.memoryEnabled,
      sensitiveMemoryEnabled: input.context.sensitiveMemoryEnabled,
      project: input.context.project,
      modelSource: 'platform',
      tierLabel: planStringValue(input.body.modelName, 120),
      renderRules: input.body.renderEnabled === true,
    },
  ) + input.historyContext, customPrompt)
}

async function planTools(input: {
  client: SupabaseClient
  userId: string
  conversationId: string
  body: PlanContextBody
  context: StoredPlanContext
}) {
  const connectorTools = input.body.privateChat ? [] : await connectorToolsForPlanRequest({
    client: input.client,
    userId: input.userId,
    ids: planConnectorIDs(input.body.connectorIds),
    mode: input.body.connectorAccessMode,
    query: planStringValue(input.body.content, 8_000) ?? '',
  })
  return responseTools(activeTools({
    loggedIn: true,
    searchMode: input.body.searchMode === 'web' ? 'web' : 'off',
    memoryEnabled: input.context.memoryEnabled,
    projectId: input.context.projectId,
  }, connectorTools))
}

export async function preparePlanContextResponse(input: {
  client: SupabaseClient
  userId: string
  conversationId: string
  userMessageId: string
  body: PlanContextBody
  signal: AbortSignal
}): Promise<object | Response> {
  const context = input.body.privateChat ? emptyPlanContext() : await loadStoredPlanContext(input)
  if (context instanceof Response) return context
  let history: Awaited<ReturnType<typeof planHistory>>
  try { history = await planHistory({ ...input, context }) }
  catch { return planResponse({ error: '历史检索服务暂时不可用' }, 503) }
  const systemPrompt = await planSystemPrompt({ ...input, context, historyContext: history.renderedContext })
  if (systemPrompt instanceof Response) return systemPrompt
  const tools = await planTools({ ...input, context })
  return {
    systemPrompt,
    messages: context.messages,
    tools,
    historySearch: historySearchEvent(history),
    conversation: {
      id: input.conversationId,
      projectId: context.projectId,
      memoryEnabled: context.memoryEnabled,
    },
  }
}
