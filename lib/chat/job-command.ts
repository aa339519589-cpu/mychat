import type { Attachment } from '@/lib/llm/types'
import type { ChatRegenerationAuthority, DurableChatRequestBody } from '@/lib/llm/chat-request'
import type { ModelOutputKind } from '@/lib/model-endpoints'
import type { SearchMode } from './request-context'
import { SupabaseJobRepository } from '@/lib/jobs/supabase-repository'
import { persistJobPayload, removeJobPayload } from '@/lib/jobs/payload-storage'
import { createAdminClient } from '@/lib/supabase/admin'
import type { JsonObject } from '@/lib/jobs/contracts'
import { jobMetrics } from '@/lib/observability/job-metrics'
import { log } from '@/lib/logger'
import { isRecord } from '@/lib/unknown-value'
import type { JobRepository } from '@/lib/jobs/repository'
import type { JobRecord } from '@/lib/jobs/contracts'
import { parseJobRecord } from '@/lib/jobs/supabase-repository'
import { JobRuntimeError } from '@/lib/jobs/errors'
import { loadRegenerationCleanupKeys } from './regeneration-cleanup'

const CHAT_POLICY_VERSION = '2026-07-13'

function sanitizedAttachments(attachments: Attachment[] | undefined): JsonObject[] | undefined {
  if (!attachments?.length) return undefined
  return attachments.map(attachment => ({
    name: attachment.name,
    dataUrl: typeof attachment.dataUrl === 'string' ? attachment.dataUrl : '',
    isPdf: attachment.isPdf === true,
    ...(typeof attachment.text === 'string' ? { text: attachment.text } : {}),
    ...(Array.isArray(attachment.pageImages) ? { pageImages: attachment.pageImages } : {}),
  }))
}

export type EnqueueChatJobInput = {
  body: DurableChatRequestBody
  userId: string
  isAnonymous: boolean
  usingBalance: boolean
  searchMode: SearchMode
  outputKind: ModelOutputKind
  requestId: string
  requestedAt?: string
}

type EnqueueChatJobDependencies = {
  persistPayload: typeof persistJobPayload
  removePayload: typeof removeJobPayload
  createRepository: () => Pick<JobRepository, 'enqueue'>
  createAdminClient: typeof createAdminClient
  loadRegenerationCleanupKeys: typeof loadRegenerationCleanupKeys
}

const DEFAULT_DEPENDENCIES: EnqueueChatJobDependencies = {
  persistPayload: persistJobPayload,
  removePayload: removeJobPayload,
  createRepository: () => new SupabaseJobRepository(),
  createAdminClient,
  loadRegenerationCleanupKeys,
}

function referencesPayload(value: unknown, objectKey: string): boolean | null {
  if (value === null) return false
  if (!isRecord(value) || !isRecord(value.payload)) return null
  const reference = value.payload.payloadRef
  if (reference === objectKey) return true
  if (isRecord(reference) && reference.objectKey === objectKey) return true
  return false
}

function rpcObject(value: unknown): Record<string, unknown> | null {
  const normalized = Array.isArray(value) ? value[0] : value
  return isRecord(normalized) ? normalized : null
}

function authoritativeRpcError(error: unknown, fallback: string): JobRuntimeError {
  const code = isRecord(error) && typeof error.code === 'string' ? error.code : ''
  return new JobRuntimeError(
    ['22023', '23503', '23505', '40001', '54000', '55000'].includes(code)
      ? 'JOB_CONFLICT'
      : 'JOB_DEPENDENCY_UNAVAILABLE',
    fallback,
  )
}

async function enqueueAuthoritativeTurn(input: {
  client: NonNullable<ReturnType<typeof createAdminClient>>
  command: EnqueueChatJobInput
  payload: JsonObject
  budget: JsonObject
  queue: string
  maxAttempts: number
}): Promise<{ created: boolean; job: JobRecord }> {
  const { body } = input.command
  const userMessage = body.messages.find(message => message.id === body.userMessageId && message.role === 'user')
  if (!userMessage || typeof userMessage.content !== 'string' || body.turn?.schemaVersion !== 1) {
    throw new JobRuntimeError('JOB_INVALID_INPUT', 'Authoritative chat turn is incomplete')
  }
  const images = userMessage.images?.length || userMessage.imageSummary
    ? {
        refs: userMessage.images ?? [],
        image_summary: userMessage.imageSummary ?? null,
        generated_media: [],
      }
    : null
  const { data, error } = await input.client.rpc('enqueue_chat_turn_v1', {
    input_user_id: input.command.userId,
    input_conversation_id: body.conversationId,
    input_create_conversation: body.turn.createConversation,
    input_project_id: body.turn.projectId,
    input_conversation_title: body.turn.title,
    input_user_message_id: body.userMessageId,
    input_user_content: userMessage.content,
    input_user_images: images,
    input_user_created_at: userMessage.ts ?? input.command.requestedAt ?? new Date().toISOString(),
    input_assistant_message_id: body.assistantMessageId,
    input_job_id: body.generationId,
    input_auth_class: input.command.isAnonymous ? 'anonymous' : 'registered',
    input_idempotency_key: `chat:${body.generationId}`,
    input_input_hash: String(input.payload.payloadHash),
    input_payload: input.payload,
    input_budget: input.budget,
    input_queue: input.queue,
    input_max_attempts: input.maxAttempts,
  })
  const result = rpcObject(data)
  if (error || (result?.enqueued !== true && result?.replayed !== true)) {
    throw authoritativeRpcError(error, 'Authoritative chat turn enqueue failed')
  }
  return {
    created: result.enqueued === true && result.replayed !== true,
    job: parseJobRecord(result.job, 'enqueue_chat_turn_v1'),
  }
}

async function enqueueAuthoritativeRegeneration(input: {
  client: NonNullable<ReturnType<typeof createAdminClient>>
  command: EnqueueChatJobInput
  authority: ChatRegenerationAuthority
  payload: JsonObject
  budget: JsonObject
  queue: string
  maxAttempts: number
  loadCleanupKeys: typeof loadRegenerationCleanupKeys
}): Promise<{ created: boolean; job: JobRecord }> {
  const { body } = input.command
  const userMessage = body.messages.find(message => message.id === body.userMessageId && message.role === 'user')
  if (!userMessage || typeof userMessage.content !== 'string') {
    throw new JobRuntimeError('JOB_INVALID_INPUT', 'Authoritative regeneration source is incomplete')
  }
  const cleanupObjectKeys = await input.loadCleanupKeys({
    client: input.client,
    userId: input.command.userId,
    conversationId: body.conversationId,
    sourceUserMessageId: body.userMessageId,
    authority: input.authority,
  })
  const { data, error } = await input.client.rpc('enqueue_chat_regeneration_v1', {
    input_user_id: input.command.userId,
    input_conversation_id: body.conversationId,
    input_operation: input.authority.operation,
    input_source_user_message_id: body.userMessageId,
    input_target_assistant_message_id: input.authority.targetAssistantMessageId ?? null,
    input_expected_tail_message_id: input.authority.expectedTailMessageId,
    input_user_content: userMessage.content,
    input_assistant_message_id: body.assistantMessageId,
    input_job_id: body.generationId,
    input_auth_class: input.command.isAnonymous ? 'anonymous' : 'registered',
    input_idempotency_key: `chat:${body.generationId}`,
    input_input_hash: String(input.payload.payloadHash),
    input_payload: input.payload,
    input_budget: input.budget,
    input_queue: input.queue,
    input_max_attempts: input.maxAttempts,
    input_cleanup_object_keys: cleanupObjectKeys,
  })
  const result = rpcObject(data)
  if (error || (result?.enqueued !== true && result?.replayed !== true)) {
    throw authoritativeRpcError(error, 'Authoritative regeneration enqueue failed')
  }
  return {
    created: result.enqueued === true && result.replayed !== true,
    job: parseJobRecord(result.job, 'enqueue_chat_regeneration_v1'),
  }
}

export async function enqueueChatJob(
  input: EnqueueChatJobInput,
  dependencyOverrides: Partial<EnqueueChatJobDependencies> = {},
) {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides }
  const { body } = input
  const outputKind = input.outputKind === 'chat' ? 'text' : input.outputKind
  const attachments = sanitizedAttachments(body.attachments)
  const command: JsonObject = {
    schemaVersion: 1,
    policyVersion: CHAT_POLICY_VERSION,
    tier: body.tier ?? '绝句',
    searchMode: input.searchMode,
    deepResearch: body.deepResearch === true,
    historyRetrieval: body.historyRetrieval === true,
    usingBalance: input.usingBalance,
    outputKind,
    requestedAt: input.requestedAt ?? new Date().toISOString(),
    ...(body.endpointId ? { endpointId: body.endpointId } : {}),
    ...(attachments ? { attachments } : {}),
  }
  const reference = await dependencies.persistPayload({
    userId: input.userId,
    jobId: body.generationId,
    payload: command,
  })
  const queue = outputKind === 'text' ? 'chat' : 'media'
  const budget: JsonObject = outputKind === 'text' ? {
    wallTimeMs: 10 * 60_000,
    tokenLimit: 160_000,
    toolCallLimit: 64,
  } : {
    wallTimeMs: 15 * 60_000,
    costMicros: 50_000_000,
  }
  const maxAttempts = outputKind === 'text' ? 3 : 2
  const storedPayload: JsonObject = {
    schemaVersion: 1,
    payloadRef: reference.objectKey,
    payloadHash: reference.sha256,
    payloadBytes: reference.bytes,
    payloadContentType: reference.contentType,
    outputKind,
    billingClass: body.endpointId ? 'customer' : 'platform',
    requestId: input.requestId,
  }
  const repository = dependencies.createRepository()
  let result: { created: boolean; job: JobRecord }
  try {
    const admin = body.turn ? dependencies.createAdminClient() : null
    result = body.turn?.schemaVersion === 1
      ? await enqueueAuthoritativeTurn({
          client: admin ?? (() => { throw new Error('command authority unavailable') })(),
          command: input,
          payload: storedPayload,
          budget,
          queue,
          maxAttempts,
        })
      : body.turn?.schemaVersion === 2
        ? await enqueueAuthoritativeRegeneration({
            client: admin ?? (() => { throw new Error('command authority unavailable') })(),
            command: input,
            authority: body.turn,
            payload: storedPayload,
            budget,
            queue,
            maxAttempts,
            loadCleanupKeys: dependencies.loadRegenerationCleanupKeys,
          })
      : await repository.enqueue({
    jobId: body.generationId,
    type: 'chat.generation',
    queue,
    principal: {
      id: input.userId,
      authClass: input.isAnonymous ? 'anonymous' : 'registered',
    },
    subject: {
      conversationId: body.conversationId,
      userMessageId: body.userMessageId,
      assistantMessageId: body.assistantMessageId,
    },
    idempotencyKey: `chat:${body.generationId}`,
    inputHash: reference.sha256,
    input: storedPayload,
    budget,
    priority: 0,
    maxAttempts,
    })
  } catch (error) {
    // Preserve a payload if the database accepted the job but the response was
    // lost. Only compensate a proven non-enqueue; otherwise cleanup owns it.
    const admin = dependencies.createAdminClient()
    let accepted: { data: unknown; error: unknown } | null = null
    try {
      accepted = admin
        ? await admin.from('jobs').select('id,payload').eq('id', body.generationId).maybeSingle()
        : null
    } catch {
      accepted = null
    }
    if (accepted && !accepted.error && referencesPayload(accepted.data, reference.objectKey) === false) {
      try {
        await dependencies.removePayload(reference, {
          userId: input.userId, jobId: body.generationId,
        })
      } catch (cleanupError) {
        log.warn('jobs', 'Immediate orphan payload compensation failed', {
          jobId: body.generationId,
          name: cleanupError instanceof Error ? cleanupError.name : 'unknown',
        })
      }
    }
    throw error
  }
  if (result.created) jobMetrics.recordEnqueued(outputKind === 'text' ? 'chat_generation'
    : outputKind === 'image' ? 'media_image' : 'media_video')
  return result
}
