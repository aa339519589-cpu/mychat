import type { ChatAppendAuthority, DurableChatRequestBody } from '@/lib/llm/chat-request'
import type { RawMsg } from '@/lib/llm/types'
import type { JobRepository } from '@/lib/jobs/repository'
import type { JobStatus, JsonObject } from '@/lib/jobs/contracts'
import { JobRuntimeError } from '@/lib/jobs/errors'
import { log } from '@/lib/logger'
import type { createAdminClient } from '@/lib/supabase/admin'

type ChatJobAdmission = {
  id: string
  status: JobStatus
}

type CompatibleTurnInput = {
  client: NonNullable<ReturnType<typeof createAdminClient>>
  body: DurableChatRequestBody
  userId: string
  isAnonymous: boolean
  requestedAt?: string
  repository: Pick<JobRepository, 'enqueue'>
  payload: JsonObject
  budget: JsonObject
  queue: string
  maxAttempts: number
}

export function isMissingAuthoritativeRpc(error: unknown): boolean {
  if (!(error instanceof JobRuntimeError)) return false
  const databaseCode = error.details.databaseCode
  return databaseCode === 'PGRST202' || databaseCode === '42883'
}

export function rejectMissingAuthoritativeRpc(error: JobRuntimeError): JobRuntimeError {
  if (isMissingAuthoritativeRpc(error)) throw error
  return error
}

export function requiredAdminClient(client: ReturnType<typeof createAdminClient>) {
  if (!client) throw new Error('command authority unavailable')
  return client
}

async function ensureCompatibleConversation(
  input: CompatibleTurnInput,
  authority: ChatAppendAuthority,
  createdAt: string,
): Promise<void> {
  const { body } = input
  if (authority.createConversation) {
    const conversation = await input.client.from('conversations').upsert({
      id: body.conversationId,
      user_id: input.userId,
      title: authority.title,
      project_id: authority.projectId,
      updated_at: createdAt,
    }, { onConflict: 'id', ignoreDuplicates: true })
    if (conversation.error) {
      throw new JobRuntimeError('JOB_DEPENDENCY_UNAVAILABLE', 'Conversation persistence failed', {
        details: {
          databaseCode: conversation.error.code ?? 'unknown',
          compatibilityFallback: true,
        },
      })
    }
  }

  const owner = await input.client.from('conversations').select('id')
    .eq('id', body.conversationId).eq('user_id', input.userId).maybeSingle()
  if (owner.error) {
    throw new JobRuntimeError('JOB_DEPENDENCY_UNAVAILABLE', 'Conversation lookup failed', {
      details: {
        databaseCode: owner.error.code ?? 'unknown',
        compatibilityFallback: true,
      },
    })
  }
  if (!owner.data) {
    throw new JobRuntimeError('JOB_CONFLICT', 'Conversation does not belong to this account')
  }
}

async function persistCompatibleMessages(
  input: CompatibleTurnInput,
  userMessage: RawMsg,
  createdAt: string,
): Promise<void> {
  const { body } = input
  const images = userMessage.images?.length || userMessage.imageSummary
    ? {
        refs: userMessage.images ?? [],
        image_summary: userMessage.imageSummary ?? null,
        generated_media: [],
      }
    : null
  const userWrite = await input.client.from('messages').upsert({
    id: body.userMessageId,
    conversation_id: body.conversationId,
    user_id: input.userId,
    role: 'user',
    content: userMessage.content,
    images,
    status: 'terminal',
    created_at: createdAt,
    updated_at: createdAt,
  } as never, { onConflict: 'id', ignoreDuplicates: true })
  if (userWrite.error) {
    throw new JobRuntimeError('JOB_DEPENDENCY_UNAVAILABLE', 'User message persistence failed', {
      details: {
        databaseCode: userWrite.error.code ?? 'unknown',
        compatibilityFallback: true,
      },
    })
  }

  const assistantWrite = await input.client.from('messages').upsert({
    id: body.assistantMessageId,
    conversation_id: body.conversationId,
    user_id: input.userId,
    role: 'assistant',
    content: '',
    images: null,
    status: 'draft',
    created_at: createdAt,
    updated_at: createdAt,
  } as never, { onConflict: 'id', ignoreDuplicates: true })
  if (assistantWrite.error) {
    throw new JobRuntimeError('JOB_DEPENDENCY_UNAVAILABLE', 'Assistant message persistence failed', {
      details: {
        databaseCode: assistantWrite.error.code ?? 'unknown',
        compatibilityFallback: true,
      },
    })
  }
}

async function persistCompatibleTurn(input: CompatibleTurnInput): Promise<void> {
  const { body } = input
  const authority = body.turn
  const userMessage = body.messages.find(message =>
    message.id === body.userMessageId && message.role === 'user')
  if (!userMessage || typeof userMessage.content !== 'string' || authority?.schemaVersion !== 1) {
    throw new JobRuntimeError('JOB_INVALID_INPUT', 'Compatible chat turn is incomplete')
  }
  const createdAt = input.requestedAt ?? new Date().toISOString()
  await ensureCompatibleConversation(input, authority, createdAt)
  await persistCompatibleMessages(input, userMessage, createdAt)
}

async function enqueueCompatibleTurn(
  input: CompatibleTurnInput,
): Promise<{ created: boolean; job: ChatJobAdmission }> {
  await persistCompatibleTurn(input)
  const { body } = input
  const result = await input.repository.enqueue({
    jobId: body.generationId,
    type: 'chat.generation',
    queue: input.queue,
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
    inputHash: String(input.payload.payloadHash),
    input: input.payload,
    budget: input.budget,
    priority: 0,
    maxAttempts: input.maxAttempts,
  })
  await input.client.from('conversations').update({ updated_at: input.requestedAt ?? new Date().toISOString() })
    .eq('id', body.conversationId).eq('user_id', input.userId)
  return { created: result.created, job: { id: result.job.id, status: result.job.status } }
}

export async function enqueueTurnWithCompatibility(
  input: CompatibleTurnInput & {
    authoritative: () => Promise<{ created: boolean; job: ChatJobAdmission }>
  },
): Promise<{ created: boolean; job: ChatJobAdmission }> {
  try {
    return await input.authoritative()
  } catch (error) {
    if (!isMissingAuthoritativeRpc(error)) throw error
    const normalized = error as JobRuntimeError
    log.warn('jobs', 'Authoritative chat RPC is unavailable; using compatible admission', {
      jobId: input.body.generationId,
      databaseCode: normalized.details.databaseCode,
    })
    return enqueueCompatibleTurn(input)
  }
}
