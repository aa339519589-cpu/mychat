import type { SupabaseServer } from '@/lib/api/guard'
import { retrieveHistoryContext } from '@/lib/llm/active-retrieval'
import type { JsonObject } from '@/lib/jobs/contracts'
import type { SupabaseClient } from '@/lib/supabase/types'
import { fetchUrlTool } from '@/lib/tools/fetch-url'
import { memoryTools } from '@/lib/tools/memory'
import type { ToolContext } from '@/lib/tools/types'
import { webSearchTool } from '@/lib/tools/web-search'

const MAX_REQUESTS_PER_ROUND = 4
const MAX_TOOL_RESULT_CHARS = 45_000
const MEMORY_LIMIT = 80

export type LongThinkSharedContext = {
  memoryEnabled: boolean
  text: string
}

type CapabilityRun = {
  state: JsonObject
  ran: boolean
  activity: string[]
}

function beijingDate(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date())
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map(item => item.trim())
    .slice(0, MAX_REQUESTS_PER_ROUND)
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function compact(value: string, limit = MAX_TOOL_RESULT_CHARS): string {
  return value.length > limit ? `${value.slice(0, limit)}\n…（工具结果已截断）` : value
}

async function memoryEnabled(client: SupabaseClient, userId: string): Promise<boolean> {
  try {
    const { data } = await client.from('profiles').select('memory_enabled').eq('user_id', userId).maybeSingle()
    return data?.memory_enabled !== false
  } catch {
    return true
  }
}

async function explicitMemories(client: SupabaseClient, userId: string): Promise<string> {
  try {
    const { data, error } = await client.from('memories').select('id,content,updated_at').eq('user_id', userId)
      .order('updated_at', { ascending: false }).limit(MEMORY_LIMIT)
    if (error || !Array.isArray(data) || data.length === 0) return ''
    return data
      .filter(row => typeof row.id === 'string' && typeof row.content === 'string')
      .map(row => `- [${row.id}] ${row.content}`)
      .join('\n')
  } catch {
    return ''
  }
}

export async function loadLongThinkSharedContext(
  client: SupabaseClient,
  userId: string,
  query: string,
  signal?: AbortSignal,
): Promise<LongThinkSharedContext> {
  const enabled = await memoryEnabled(client, userId)
  if (!enabled) return { memoryEnabled: false, text: 'MyChat Memory 当前已关闭。' }

  const [memories, history] = await Promise.all([
    explicitMemories(client, userId),
    retrieveHistoryContext({
      supabase: client as unknown as SupabaseServer,
      userId,
      conversationId: null,
      projectId: null,
      query,
      mode: 'deep',
      signal,
    }),
  ])
  const blocks = [
    memories ? `【MyChat 全局长期记忆】\n${memories}` : '',
    history ? `【MyChat 历史对话主动检索】\n${history}` : '',
  ].filter(Boolean)
  return {
    memoryEnabled: true,
    text: blocks.length ? blocks.join('\n\n') : 'MyChat Memory 已开启，目前没有检索到与本任务相关的既有记忆。',
  }
}

function toolContext(client: SupabaseClient, userId: string, memoryIsEnabled: boolean, signal?: AbortSignal): ToolContext {
  return {
    supabase: client,
    userId,
    projectId: null,
    searchMode: 'web',
    latestBeijingDate: beijingDate(),
    signal,
  }
}

async function runWebQueries(state: JsonObject, ctx: ToolContext): Promise<{ results: string[]; activity: string[] }> {
  const queries = strings(state.web_queries)
  const results: string[] = []
  const activity: string[] = []
  for (const query of queries) {
    const outcome = await webSearchTool.execute({ query }, ctx)
    results.push(`查询：${query}\n${compact(outcome.result)}`)
    activity.push(`联网搜索：${query}`)
  }
  return { results, activity }
}

async function runFetches(state: JsonObject, ctx: ToolContext): Promise<{ results: string[]; activity: string[] }> {
  const urls = strings(state.fetch_urls)
  const results: string[] = []
  const activity: string[] = []
  for (const url of urls) {
    const outcome = await fetchUrlTool.execute({ url }, ctx)
    results.push(`网址：${url}\n${compact(outcome.result, 16_000)}`)
    activity.push(`读取网页：${url}`)
  }
  return { results, activity }
}

async function runMemoryActions(
  state: JsonObject,
  ctx: ToolContext,
  enabled: boolean,
): Promise<{ results: string[]; activity: string[] }> {
  if (!enabled || !Array.isArray(state.memory_actions)) return { results: [], activity: [] }
  const results: string[] = []
  const activity: string[] = []
  for (const item of state.memory_actions.slice(0, MAX_REQUESTS_PER_ROUND)) {
    const row = object(item)
    const name = typeof row?.name === 'string' ? row.name : ''
    const args = object(row?.arguments) ?? {}
    const tool = memoryTools.find(candidate => candidate.name === name && candidate.enabled({
      loggedIn: true, searchMode: 'web', memoryEnabled: true, projectId: null,
    }))
    if (!tool) continue
    const outcome = await tool.execute(args, ctx)
    results.push(`${name}: ${compact(outcome.result, 4_000)}`)
    activity.push(`Memory：${name}`)
  }
  return { results, activity }
}

export async function runLongThinkCapabilities(
  state: JsonObject,
  client: SupabaseClient,
  userId: string,
  memoryIsEnabled: boolean,
  signal?: AbortSignal,
): Promise<CapabilityRun> {
  const ctx = toolContext(client, userId, memoryIsEnabled, signal)
  const [web, pages, memory] = await Promise.all([
    runWebQueries(state, ctx),
    runFetches(state, ctx),
    runMemoryActions(state, ctx, memoryIsEnabled),
  ])
  const toolResults = [...web.results, ...pages.results, ...memory.results]
  const activity = [...web.activity, ...pages.activity, ...memory.activity]
  if (toolResults.length === 0) return { state, ran: false, activity: [] }

  const previous = Array.isArray(state._capability_results)
    ? state._capability_results.filter((item): item is string => typeof item === 'string').slice(-8)
    : []
  const nextState: JsonObject = {
    ...state,
    done: false,
    web_queries: [],
    fetch_urls: [],
    memory_actions: [],
    _capability_results: [...previous, ...toolResults].slice(-12),
    _capability_activity: activity,
  }
  return { state: nextState, ran: true, activity }
}
