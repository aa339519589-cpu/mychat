import type { SupabaseClient } from '@/lib/supabase/types'
import type { SupabaseServer } from '@/lib/api/guard'
import {
  AuthoritativeContextError,
  loadAuthoritativeChatContext,
} from '@/lib/chat/authoritative-context'
import { resolveChatModelSelection, type ChatModelSelection } from '@/lib/chat/model-selection'
import type { SearchMode } from '@/lib/chat/request-context'
import { loadCustomSystemPrompt } from '@/lib/chat/user-system-prompt'
import type { Attachment } from '@/lib/llm/types'
import { log } from '@/lib/logger'
import { createAdminClient } from '@/lib/supabase/admin'
import { sha256JobValue } from '../canonical'
import { loadJobPayload, type JobPayloadReference } from '../payload-storage'
import { isJsonValue, type JobRecord, type JsonObject } from '../contracts'
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
  context: Awaited<ReturnType<typeof loadAuthoritativeChatContext>> & {
    customSystemPrompt: string
  }
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

function embeddedCommand(job: JobRecord): JsonObject | null {
  const input = record(job.input)
  if (!input) {
    throw new JobRuntimeError('JOB_INVALID_INPUT', 'Chat job input is invalid')
  }
  const value = record(input?.command)
  if (!value) return null
  if (input?.payloadRef !== undefined
    || typeof input.payloadHash !== 'string'
    || !/^[0-9a-f]{64}$/.test(input.payloadHash)
    || !isJsonValue(value)
    || sha256JobValue(value) !== input.payloadHash) {
    throw new JobRuntimeError('JOB_INVALID_INPUT', 'Inline chat command integrity failed')
  }
  return value
}

async function loadCommandPayload(
  job: JobRecord,
  scope: { userId: string; jobId: string },
): Promise<{ payload: JsonObject; mode: 'inline' | 'object' }> {
  const inline = embeddedCommand(job)
  if (inline) return { payload: inline, mode: 'inline' }
  return {
    payload: await loadJobPayload(reference(job), scope),
    mode: 'object',
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
    || (searchMode !== 'off' && searchMode !== 'web')
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

function allowInstantContext(value: LoadedChatJob['command']): boolean {
  return value.outputKind === 'text'
    && value.searchMode === 'off'
    && !value.deepResearch
    && !value.attachments?.length
}

export async function loadChatJob(job: JobRecord): Promise<LoadedChatJob> {
  const startedAt = Date.now()
  let client: SupabaseClient | null
  try { client = createAdminClient() } catch (error) {
    throw new JobRuntimeError('JOB_DEPENDENCY_UNAVAILABLE', 'Database authority is unavailable', { cause: error })
  }
  if (!client) throw new JobRuntimeError('JOB_DEPENDENCY_UNAVAILABLE', 'Database authority is unavailable')
  const userId = job.principal.id
  const conversationId = identity(job, 'conversationId')
  const userMessageId = identity(job, 'userMessageId')
  const assistantMessageId = identity(job, 'assistantMessageId')
  try {
    const [loadedCommand, customSystemPrompt] = await Promise.all([
      loadCommandPayload(job, { userId, jobId: job.id }),
      loadCustomSystemPrompt(client, userId),
    ])
    const payloadReadyAt = Date.now()
    const parsedCommand = command(loadedCommand.payload)
    const jobInput = record(job.input)
    const admission = record(jobInput?.admission)
    const billingClass = jobInput?.billingClass
    const [authoritativeContext, selection] = await Promise.all([
      loadAuthoritativeChatContext({
        client,
        userId,
        conversationId,
        userMessageId,
        allowInstant: allowInstantContext(parsedCommand),
      }),
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
    if ((billingClass === 'customer') !== selection.customEndpoint
      || (billingClass !== 'customer' && billingClass !== 'platform')) {
      throw new JobRuntimeError('JOB_CONFLICT', 'Billing authority changed after enqueue')
    }
    log.info('jobs', 'Chat job preparation timing', {
      jobId: job.id,
      payloadMode: loadedCommand.mode,
      payloadAndPromptMs: payloadReadyAt - startedAt,
      contextAndPolicyMs: Date.now() - payloadReadyAt,
      totalMs: Date.now() - startedAt,
    })
    return {
      client,
      userId,
      conversationId,
      userMessageId,
      assistantMessageId,
      command: {
        ...parsedCommand,
        usingBalance: admission?.funding === 'balance',
      },
      context: { ...authoritativeContext, customSystemPrompt },
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
