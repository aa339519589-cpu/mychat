import type { SupabaseClient } from '@supabase/supabase-js'
import type { Memory } from '@/lib/memory-data'
import type { ProjectContext } from '@/lib/project-data'
import type { RawMsg } from '@/lib/llm/types'
import { isRecord } from '@/lib/unknown-value'

const MAX_CONTEXT_MESSAGES = 500
const MAX_MEMORIES = 200
const MAX_PROJECT_FILES = 30

type MessageRow = {
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
      | 'CONTEXT_UNAVAILABLE',
    message: string,
  ) {
    super(message)
    this.name = 'AuthoritativeContextError'
  }
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
  const [projectResult, filesResult, memoriesResult] = await Promise.all([
    client.from('projects').select('id, instructions').eq('id', projectId)
      .eq('user_id', userId).maybeSingle(),
    client.from('project_files').select('name, content').eq('project_id', projectId)
      .eq('user_id', userId).order('created_at').limit(MAX_PROJECT_FILES),
    client.from('project_memories').select('id, content').eq('project_id', projectId)
      .eq('user_id', userId).order('created_at').limit(MAX_MEMORIES),
  ])
  if (projectResult.error || filesResult.error || memoriesResult.error || !projectResult.data) {
    throw new AuthoritativeContextError('CONTEXT_UNAVAILABLE', '项目上下文暂时不可用')
  }
  return {
    id: projectId,
    instructions: typeof projectResult.data.instructions === 'string'
      ? projectResult.data.instructions
      : '',
    files: (filesResult.data ?? []).map(file => ({
      name: typeof file.name === 'string' ? file.name : '',
      content: typeof file.content === 'string' ? file.content : '',
    })),
    projectMemories: (memoriesResult.data ?? []).map(memory => ({
      id: String(memory.id),
      content: typeof memory.content === 'string' ? memory.content : '',
    })),
  }
}

async function loadGlobalMemories(
  client: SupabaseClient,
  userId: string,
): Promise<{ enabled: boolean; memories: Memory[] }> {
  const [profileResult, memoriesResult] = await Promise.all([
    client.from('profiles').select('memory_enabled').eq('user_id', userId).maybeSingle(),
    client.from('memories').select('id, content, created_at, updated_at').eq('user_id', userId)
      .order('created_at').limit(MAX_MEMORIES),
  ])
  if (profileResult.error || memoriesResult.error) {
    throw new AuthoritativeContextError('CONTEXT_UNAVAILABLE', '记忆上下文暂时不可用')
  }
  const enabled = profileResult.data?.memory_enabled !== false
  return {
    enabled,
    memories: enabled ? (memoriesResult.data ?? []).map(memory => ({
      id: String(memory.id),
      content: typeof memory.content === 'string' ? memory.content : '',
      timestamp: typeof memory.updated_at === 'string'
        ? memory.updated_at
        : typeof memory.created_at === 'string' ? memory.created_at : undefined,
    })) : [],
  }
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

  let historyQuery = client.from('messages')
    .select('id, role, content, content_parts, media_refs, images, created_at, seq')
    .eq('conversation_id', conversationId)
    .eq('user_id', userId)
    .in('role', ['user', 'assistant'])
  const userSequence = Number(userMessageResult.data.seq)
  if (Number.isSafeInteger(userSequence) && userSequence > 0) {
    historyQuery = historyQuery.lte('seq', userSequence).order('seq', { ascending: false })
  } else {
    historyQuery = historyQuery.order('created_at', { ascending: false })
  }
  const historyResult = await historyQuery.limit(MAX_CONTEXT_MESSAGES)
  if (historyResult.error) {
    throw new AuthoritativeContextError('CONTEXT_UNAVAILABLE', '消息上下文暂时不可用')
  }
  const rows = (historyResult.data ?? []) as MessageRow[]
  if (!rows.some(row => row.id === userMessageId && row.role === 'user')) {
    throw new AuthoritativeContextError('USER_MESSAGE_NOT_FOUND', '用户消息不在权威历史中')
  }
  const messages = rows.reverse().map(rawMessage)

  const projectId = typeof conversationResult.data.project_id === 'string'
    ? conversationResult.data.project_id
    : null
  if (projectId) {
    return {
      messages,
      memories: [],
      memoryEnabled: false,
      project: await loadProjectContext(client, userId, projectId),
    }
  }
  const globalMemory = await loadGlobalMemories(client, userId)
  return {
    messages,
    memories: globalMemory.memories,
    memoryEnabled: globalMemory.enabled,
  }
}
