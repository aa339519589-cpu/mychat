import type { SupabaseClient } from '@supabase/supabase-js'
import type { SupabaseServer } from '@/lib/api/guard'
import {
  AuthoritativeContextError,
  loadAuthoritativeChatContext,
} from '@/lib/chat/authoritative-context'
import { resolveChatModelSelection, type ChatModelSelection } from '@/lib/chat/model-selection'
import type { SearchMode } from '@/lib/chat/request-context'
import type { Attachment } from '@/lib/llm/types'
import { createAdminClient } from '@/lib/supabase/admin'
import { loadJobPayload, type JobPayloadReference } from '../payload-storage'
import type { JobRecord, JsonObject } from '../contracts'
import { JobRuntimeError } from '../errors'

export type LoadedChatJob = {
  client: SupabaseClient
  userId: string
  conversationId: string
  userMessageId: string
  assistantMessageId: string
  command: {
    tier: string
    endpointId?: string
    searchMode: SearchMode
    deepResearch: boolean
    historyRetrieval: boolean
    usingBalance: boolean
    outputKind: 'text' | 'image' | 'video'
    attachments?: Attachment[]
  }
  context: Awaited<ReturnType<typeof loadAuthoritativeChatContext>>
  selection: ChatModelSelection
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function identity(job: JobRecord, field: string): string {
  const value = job.subject[field]
  if (typeof value !== 'string') throw new JobRuntimeError('JOB_INVALID_INPUT', `Missing ${field}`)
  return value
}

function reference(job: JobRecord): JobPayloadReference {
  const input = record(job.input)
  const nested = record(input?.payloadRef)
  if (nested) return nested as JobPayloadReference
  if (typeof input?.payloadRef !== 'string' || typeof input.payloadHash !== 'string'
    || !Number.isSafeInteger(input.payloadBytes) || input.payloadContentType !== 'application/json') {
    throw new JobRuntimeError('JOB_INVALID_INPUT', 'Job payload reference is invalid')
  }
  return {
    bucket: 'job-payloads',
    objectKey: input.payloadRef,
    sha256: input.payloadHash,
    bytes: Number(input.payloadBytes),
    contentType: 'application/json',
  }
}

function attachments(value: unknown): Attachment[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > 8) {
    throw new JobRuntimeError('JOB_INVALID_INPUT', 'Job attachments are invalid')
  }
  return value.map(item => {
    const source = record(item)
    if (!source || typeof source.name !== 'string' || typeof source.dataUrl !== 'string'
      || typeof source.isPdf !== 'boolean'
      || (source.text !== undefined && typeof source.text !== 'string')
      || (source.pageImages !== undefined && (!Array.isArray(source.pageImages)
        || source.pageImages.some(image => typeof image !== 'string')))) {
      throw new JobRuntimeError('JOB_INVALID_INPUT', 'Job attachment is malformed')
    }
    return {
      name: source.name,
      dataUrl: source.dataUrl,
      isPdf: source.isPdf,
      ...(typeof source.text === 'string' ? { text: source.text } : {}),
      ...(Array.isArray(source.pageImages) ? { pageImages: source.pageImages as string[] } : {}),
    }
  })
}

function command(value: JsonObject): LoadedChatJob['command'] {
  const outputKind = value.outputKind
  const searchMode = value.searchMode
  if (typeof value.tier !== 'string'
    || (outputKind !== 'text' && outputKind !== 'image' && outputKind !== 'video')
    || (searchMode !== 'off' && searchMode !== 'web' && searchMode !== 'deep')
    || typeof value.deepResearch !== 'boolean'
    || typeof value.historyRetrieval !== 'boolean'
    || typeof value.usingBalance !== 'boolean'
    || (value.endpointId !== undefined && typeof value.endpointId !== 'string')) {
    throw new JobRuntimeError('JOB_INVALID_INPUT', 'Chat job command is malformed')
  }
  return {
    tier: value.tier,
    outputKind,
    searchMode,
    deepResearch: value.deepResearch,
    historyRetrieval: value.historyRetrieval,
    usingBalance: value.usingBalance,
    ...(typeof value.endpointId === 'string' ? { endpointId: value.endpointId } : {}),
    ...(value.attachments !== undefined ? { attachments: attachments(value.attachments) } : {}),
  }
}

export async function loadChatJob(job: JobRecord): Promise<LoadedChatJob> {
  let client: SupabaseClient | null
  try { client = createAdminClient() } catch (error) {
    throw new JobRuntimeError('JOB_DEPENDENCY_UNAVAILABLE', 'Database authority is unavailable', { cause: error })
  }
  if (!client) throw new JobRuntimeError('JOB_DEPENDENCY_UNAVAILABLE', 'Database authority is unavailable')
  const userId = job.principal.id
  const conversationId = identity(job, 'conversationId')
  const userMessageId = identity(job, 'userMessageId')
  const assistantMessageId = identity(job, 'assistantMessageId')
  const payload = await loadJobPayload(reference(job), { userId, jobId: job.id })
  const parsedCommand = command(payload)
  try {
    const [authoritativeContext, selection] = await Promise.all([
      loadAuthoritativeChatContext({ client, userId, conversationId, userMessageId }),
      resolveChatModelSelection({
        tier: parsedCommand.tier,
        deepResearch: parsedCommand.deepResearch,
        endpointId: parsedCommand.endpointId,
        supabase: client as unknown as SupabaseServer,
        userId,
      }),
    ])
    const selectedKind = selection.outputKind === 'chat' ? 'text' : selection.outputKind
    if (selectedKind !== parsedCommand.outputKind) {
      throw new JobRuntimeError('JOB_CONFLICT', 'Model policy changed after enqueue')
    }
    return {
      client,
      userId,
      conversationId,
      userMessageId,
      assistantMessageId,
      command: parsedCommand,
      context: authoritativeContext,
      selection,
    }
  } catch (error) {
    if (error instanceof JobRuntimeError) throw error
    if (error instanceof AuthoritativeContextError) {
      throw new JobRuntimeError(
        error.code === 'CONTEXT_UNAVAILABLE' ? 'JOB_DEPENDENCY_UNAVAILABLE' : 'JOB_INVALID_INPUT',
        error.message,
        { cause: error },
      )
    }
    throw new JobRuntimeError('JOB_DEPENDENCY_UNAVAILABLE', 'Chat policy is unavailable', { cause: error })
  }
}
