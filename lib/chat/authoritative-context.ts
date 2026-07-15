import type { SupabaseClient } from '@supabase/supabase-js'
import type { Memory } from '@/lib/memory-data'
import type { ProjectContext } from '@/lib/project-data'
import type { RawMsg } from '@/lib/llm/types'
import { isRecord } from '@/lib/unknown-value'

const MAX_CONTEXT_MESSAGES = 120
const MAX_MESSAGE_HISTORY_BYTES = 512 * 1024
const MAX_AUTHORITATIVE_CONTEXT_BYTES = 1024 * 1024
const MAX_MEMORIES = 200
const MAX_PROJECT_FILES = 30
const CONTEXT_PAGE_SIZE = 8

export type MessageRow = {
  id: string
  role: string
  content: string | null
  content_parts?: unknown
  media_refs?: unknown
  images: unknown
  created_at: string | null
  seq?: number | null
}

export class AuthoritativeContextError extends Error {
  constructor(
    public readonly code:
      | 'CONVERSATION_NOT_FOUND'
      | 'USER_MESSAGE_NOT_FOUND'
      | 'CONTEXT_TOO_LARGE'
      | 'CONTEXT_UNAVAILABLE',
    message: string,
  ) {
    super(message)
    this.name = 'AuthoritativeContextError'
  }
}

const encoder = new TextEncoder()

function jsonBytes(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).byteLength
}

/** Rows arrive newest-first; retain one contiguous suffix without truncating a message. */
export function compileAuthoritativeMessages(
  rows: MessageRow[],
  userMessageId: string,
  maxBytes = MAX_MESSAGE_HISTORY_BYTES,
): RawMsg[] {
  const compiled: RawMsg[] = []
  let bytes = 0
  for (const row of rows) {
    const message = rawMessage(row)
    const messageBytes = jsonBytes(message)
    if (row.id === userMessageId && messageBytes > maxBytes) {
      throw new AuthoritativeContextError('CONTEXT_TOO_LARGE', '当前消息超过模型上下文上限')
    }
    if (bytes + messageBytes > maxBytes) break
    compiled.push(message)
    bytes += messageBytes
  }
  return compiled.reverse()
}

function assertContextBudget(value: unknown): void {
  if (jsonBytes(value) > MAX_AUTHORITATIVE_CONTEXT_BYTES) {
    throw new AuthoritativeContextError('CONTEXT_TOO_LARGE', '权威对话、项目或记忆上下文超过处理上限')
  }
}

type PageResult = { data: unknown; error: unknown }

async function loadBoundedCollection<T>(input: {
  maxRows: number
  fetchPage: (from: number, to: number) => PromiseLike<PageResult>
  map: (value: unknown) => T
  unavailableMessage: string
}): Promise<T[]> {
  const values: T[] = []
  let bytes = 2
  for (let offset = 0; offset < input.maxRows; offset += CONTEXT_PAGE_SIZE) {
    const pageSize = Math.min(CONTEXT_PAGE_SIZE, input.maxRows - offset)
    const result = await input.fetchPage(offset, offset + pageSize - 1)
    if (result.error || !Array.isArray(result.data)) {
      throw new AuthoritativeContextError('CONTEXT_UNAVAILABLE', input.unavailableMessage)
    }
    for (const row of result.data) {
      const mapped = input.map(row)
      bytes += jsonBytes(mapped) + 1
      if (bytes > MAX_AUTHORITATIVE_CONTEXT_BYTES) {
        throw new AuthoritativeContextError(
          'CONTEXT_TOO_LARGE',
          '权威对话、项目或记忆上下文超过处理上限',
        )
      }
      values.push(mapped)
    }
    if (result.data.length < pageSize) break
  }
  return values
}

function rawMessage(row: MessageRow): RawMsg {
  const authoritativeRefs = Array.isArray(row.media_refs)
    ? row.media_refs.filter((value): value is string => typeof value === 'string')
    : []
  const legacyImages = isRecord(row.images) && Array.isArray(row.images.refs)
    ? row.images.refs.filter((value): value is string => typeof value === 'string')
    : Array.isArray(row.images)
      ? row.images.filter((value): value is string => typeof value === 'string')
      : undefined
  const images = authoritativeRefs.length ? authoritativeRefs : legacyImages
  const imageSummary = isRecord(row.images) && typeof row.images.image_summary === 'string'
    ? row.images.image_summary
    : undefined
  const content = Array.isArray(row.content_parts) && row.content_parts.length
    ? row.content_parts
    : row.content ?? ''
  return {
    id: row.id,
    role: row.role,
    content,
    ...(images?.length ? { images } : {}),
    ...(imageSummary ? { imageSummary } : {}),
    ...(row.created_at ? { ts: row.created_at } : {}),
  }
}

async function loadProjectContext(
  client: SupabaseClient,
  userId: string,
  projectId: string,
): Promise<ProjectContext> {
  const projectResult = await client.from('projects').select('id, instructions').eq('id', projectId)
    .eq('user_id', userId).maybeSingle()
  if (projectResult.error || !projectResult.data) {
    throw new AuthoritativeContextError('CONTEXT_UNAVAILABLE', '项目上下文暂时不可用')
  }
  const base = {
    id: projectId,
    instructions: typeof projectResult.data.instructions === 'string'
      ? projectResult.data.instructions
      : '',
  }
  assertContextBudget(base)
  const [files, projectMemories] = await Promise.all([
    loadBoundedCollection({
      maxRows: MAX_PROJECT_FILES,
      fetchPage: (from, to) => client.from('project_files').select('name, content')
        .eq('project_id', projectId).eq('user_id', userId).order('created_at').range(from, to),
      map: value => {
        const file = isRecord(value) ? value : {}
        return {
          name: typeof file.name === 'string' ? file.name : '',
          content: typeof file.content === 'string' ? file.content : '',
        }
      },
      unavailableMessage: '项目文件上下文暂时不可用',
    }),
    loadBoundedCollection({
      maxRows: MAX_MEMORIES,
      fetchPage: (from, to) => client.from('project_memories').select('id, content')
        .eq('project_id', projectId).eq('user_id', userId).order('created_at').range(from, to),
      map: value => {
        const memory = isRecord(value) ? value : {}
        return {
          id: String(memory.id),
          content: typeof memory.content === 'string' ? memory.content : '',
        }
      },
      unavailableMessage: '项目记忆上下文暂时不可用',
    }),
  ])
  return { ...base, files, projectMemories }
}

async function loadGlobalMemories(
  client: SupabaseClient,
  userId: string,
): Promise<{ enabled: boolean; memories: Memory[] }> {
  const profileResult = await client.from('profiles').select('memory_enabled')
    .eq('user_id', userId).maybeSingle()
  if (profileResult.error) {
    throw new AuthoritativeContextError('CONTEXT_UNAVAILABLE', '记忆上下文暂时不可用')
  }
  const enabled = profileResult.data?.memory_enabled !== false
  if (!enabled) return { enabled, memories: [] }
  const memories = await loadBoundedCollection<Memory>({
    maxRows: MAX_MEMORIES,
    fetchPage: (from, to) => client.from('memories')
      .select('id, content, created_at, updated_at').eq('user_id', userId)
      .order('created_at').range(from, to),
    map: value => {
      const memory = isRecord(value) ? value : {}
      return {
        id: String(memory.id),
        content: typeof memory.content === 'string' ? memory.content : '',
        timestamp: typeof memory.updated_at === 'string'
          ? memory.updated_at
          : typeof memory.created_at === 'string' ? memory.created_at : undefined,
      }
    },
    unavailableMessage: '记忆上下文暂时不可用',
  })
  return {
    enabled,
    memories,
  }
}

async function loadMessageHistory(input: {
  client: SupabaseClient
  conversationId: string
  userId: string
  userMessageId: string
  userSequence: number | null
}): Promise<RawMsg[]> {
  const compiled: RawMsg[] = []
  let bytes = 0
  let foundUserMessage = false
  let budgetReached = false
  for (let offset = 0; offset < MAX_CONTEXT_MESSAGES; offset += CONTEXT_PAGE_SIZE) {
    const pageSize = Math.min(CONTEXT_PAGE_SIZE, MAX_CONTEXT_MESSAGES - offset)
    let query = input.client.from('messages')
      .select('id, role, content, content_parts, media_refs, images, created_at, seq')
      .eq('conversation_id', input.conversationId)
      .eq('user_id', input.userId)
      .in('role', ['user', 'assistant'])
    query = input.userSequence === null
      ? query.order('created_at', { ascending: false })
      : query.lte('seq', input.userSequence).order('seq', { ascending: false })
    const result = await query.range(offset, offset + pageSize - 1)
    if (result.error || !Array.isArray(result.data)) {
      throw new AuthoritativeContextError('CONTEXT_UNAVAILABLE', '消息上下文暂时不可用')
    }
    for (const value of result.data) {
      const row = value as MessageRow
      const message = rawMessage(row)
      const messageBytes = jsonBytes(message)
      if (row.id === input.userMessageId && row.role === 'user') {
        foundUserMessage = true
        if (messageBytes > MAX_MESSAGE_HISTORY_BYTES) {
          throw new AuthoritativeContextError('CONTEXT_TOO_LARGE', '当前消息超过模型上下文上限')
        }
      }
      if (bytes + messageBytes > MAX_MESSAGE_HISTORY_BYTES) {
        budgetReached = true
        break
      }
      compiled.push(message)
      bytes += messageBytes
    }
    if (budgetReached || result.data.length < pageSize) break
  }
  if (!foundUserMessage) {
    throw new AuthoritativeContextError('USER_MESSAGE_NOT_FOUND', '用户消息不在权威历史中')
  }
  return compiled.reverse()
}

/**
 * Rebuild model context from the database authority. Client-supplied history,
 * memories, and project documents are never promoted into the model request.
 */
export async function loadAuthoritativeChatContext(input: {
  client: SupabaseClient
  userId: string
  conversationId: string
  userMessageId: string
}): Promise<{
  messages: RawMsg[]
  memories: Memory[]
  memoryEnabled: boolean
  project?: ProjectContext
}> {
  const { client, userId, conversationId, userMessageId } = input
  const [conversationResult, userMessageResult] = await Promise.all([
    client.from('conversations').select('id, project_id').eq('id', conversationId)
      .eq('user_id', userId).maybeSingle(),
    client.from('messages').select('id, role, conversation_id, user_id, seq')
      .eq('id', userMessageId).eq('conversation_id', conversationId)
      .eq('user_id', userId).eq('role', 'user').maybeSingle(),
  ])
  if (conversationResult.error || userMessageResult.error) {
    throw new AuthoritativeContextError('CONTEXT_UNAVAILABLE', '对话上下文暂时不可用')
  }
  if (!conversationResult.data) {
    throw new AuthoritativeContextError('CONVERSATION_NOT_FOUND', '对话不存在')
  }
  if (!userMessageResult.data) {
    throw new AuthoritativeContextError('USER_MESSAGE_NOT_FOUND', '用户消息不存在')
  }

  const userSequence = Number(userMessageResult.data.seq)
  const messages = await loadMessageHistory({
    client,
    conversationId,
    userId,
    userMessageId,
    userSequence: Number.isSafeInteger(userSequence) && userSequence > 0 ? userSequence : null,
  })

  const projectId = typeof conversationResult.data.project_id === 'string'
    ? conversationResult.data.project_id
    : null
  if (projectId) {
    const project = await loadProjectContext(client, userId, projectId)
    assertContextBudget({ messages, project })
    return {
      messages,
      memories: [],
      memoryEnabled: false,
      project,
    }
  }
  const globalMemory = await loadGlobalMemories(client, userId)
  assertContextBudget({ messages, memories: globalMemory.memories })
  return {
    messages,
    memories: globalMemory.memories,
    memoryEnabled: globalMemory.enabled,
  }
}
