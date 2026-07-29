import type { DurableChatRequestBody } from '@/lib/llm/chat-request'
import type { RawMsg } from '@/lib/llm/types'
import { isJobIdentifier, isJobStatus, type JobStatus, type JsonObject } from '@/lib/jobs/contracts'
import { JobRuntimeError } from '@/lib/jobs/errors'
import { log } from '@/lib/logger'
import type { createAdminClient } from '@/lib/supabase/admin'
import { isRecord } from '@/lib/unknown-value'

type ChatJobAdmission = {
  id: string
  status: JobStatus
}

type DirectTurnInput = {
  client: NonNullable<ReturnType<typeof createAdminClient>>
  body: DurableChatRequestBody
  userId: string
  isAnonymous: boolean
  requestedAt?: string
  payload: JsonObject
  budget: JsonObject
  queue: string
  maxAttempts: number
}

export function requiredAdminClient(client: ReturnType<typeof createAdminClient>) {
  if (!client) throw new JobRuntimeError(
    'JOB_DEPENDENCY_UNAVAILABLE',
    'Database authority is unavailable',
  )
  return client
}

function messageImages(userMessage: RawMsg) {
  return userMessage.images?.length || userMessage.imageSummary
    ? {
        refs: userMessage.images ?? [],
        image_summary: userMessage.imageSummary ?? null,
        generated_media: [],
      }
    : null
}

function databaseDetails(error: unknown): JsonObject {
  if (!isRecord(error)) return {}
  return {
    ...(typeof error.code === 'string' ? { databaseCode: error.code } : {}),
    ...(typeof error.message === 'string' ? { databaseMessage: error.message } : {}),
    ...(typeof error.details === 'string' ? { databaseDetails: error.details } : {}),
    ...(typeof error.hint === 'string' ? { databaseHint: error.hint } : {}),
    ...(typeof error.status === 'number' || typeof error.status === 'string'
      ? { status: error.status }
      : {}),
  }
}

function directAdmissionError(error: unknown): JobRuntimeError {
  const details = databaseDetails(error)
  const code = typeof details.databaseCode === 'string' ? details.databaseCode : ''
  const message = typeof details.databaseMessage === 'string'
    ? `Direct chat admission (${code || 'unknown'}) failed: ${details.databaseMessage}`
    : `Direct chat admission${code ? ` (${code})` : ''} failed`
  const deterministicInfrastructure = ['42501', '42P01', '42703', '42883'].includes(code)
  const invalidInput = ['22023', '22P02', '23502', '23514'].includes(code)
  const conflict = ['23503', '23505', '40001', '55000'].includes(code)
  const normalized = new JobRuntimeError(
    invalidInput ? 'JOB_INVALID_INPUT' : conflict ? 'JOB_CONFLICT' : 'JOB_DEPENDENCY_UNAVAILABLE',
    message,
    {
      retryable: !invalidInput && !conflict && !deterministicInfrastructure,
      details,
      cause: error,
    },
  )
  log.error('jobs', 'Direct chat admission RPC failed', {
    rpc: 'admit_chat_turn_v2',
    ...details,
  })
  return normalized
}

function admissionResult(
  data: unknown,
  expectedJobId: string,
): { created: boolean; job: ChatJobAdmission } {
  const result = isRecord(Array.isArray(data) ? data[0] : data)
    ? (Array.isArray(data) ? data[0] : data)
    : null
  const job = isRecord(result?.job) ? result.job : null
  if ((result?.enqueued !== true && result?.replayed !== true)
    || !isJobIdentifier(job?.id)
    || job.id !== expectedJobId
    || !isJobStatus(job.status)) {
    throw new JobRuntimeError(
      'JOB_DEPENDENCY_UNAVAILABLE',
      'Direct chat admission response was malformed',
      { retryable: false, details: { rpc: 'admit_chat_turn_v2', expectedJobId } },
    )
  }
  return {
    created: result.enqueued === true && result.replayed !== true,
    job: { id: job.id, status: job.status },
  }
}

export async function enqueueDirectTurn(
  input: DirectTurnInput,
): Promise<{ created: boolean; job: ChatJobAdmission }> {
  const { body } = input
  const authority = body.turn
  const userMessage = body.messages.find(message =>
    message.id === body.userMessageId && message.role === 'user')
  if (!userMessage || typeof userMessage.content !== 'string' || authority?.schemaVersion !== 1) {
    throw new JobRuntimeError('JOB_INVALID_INPUT', 'Chat turn is incomplete')
  }

  const createdAt = typeof userMessage.ts === 'string'
    ? userMessage.ts
    : input.requestedAt ?? new Date().toISOString()
  let response: { data: unknown; error: unknown }
  try {
    response = await input.client.rpc('admit_chat_turn_v2', {
      input_user_id: input.userId,
      input_conversation_id: body.conversationId,
      input_create_conversation: authority.createConversation,
      input_project_id: authority.projectId,
      input_conversation_title: authority.title,
      input_user_message_id: body.userMessageId,
      input_user_content: userMessage.content,
      input_user_images: messageImages(userMessage),
      input_user_created_at: createdAt,
      input_assistant_message_id: body.assistantMessageId,
      input_job_id: body.generationId,
      input_auth_class: input.isAnonymous ? 'anonymous' : 'registered',
      input_idempotency_key: `chat:${body.generationId}`,
      input_input_hash: String(input.payload.payloadHash),
      input_payload: input.payload,
      input_budget: input.budget,
      input_queue: input.queue,
      input_max_attempts: input.maxAttempts,
    })
  } catch (error) {
    throw directAdmissionError(error)
  }
  if (response.error) throw directAdmissionError(response.error)
  return admissionResult(response.data, body.generationId)
}
