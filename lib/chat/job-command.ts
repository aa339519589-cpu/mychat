import type { Attachment } from '@/lib/llm/types'
import type { DurableChatRequestBody } from '@/lib/llm/chat-request'
import type { ModelOutputKind } from '@/lib/model-endpoints'
import type { SearchMode } from './request-context'
import { SupabaseJobRepository } from '@/lib/jobs/supabase-repository'
import { persistJobPayload, removeJobPayload } from '@/lib/jobs/payload-storage'
import { createAdminClient } from '@/lib/supabase/admin'
import type { JsonObject } from '@/lib/jobs/contracts'
import { jobMetrics } from '@/lib/observability/job-metrics'

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

export async function enqueueChatJob(input: EnqueueChatJobInput) {
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
  const reference = await persistJobPayload({
    userId: input.userId,
    jobId: body.generationId,
    payload: command,
  })
  const queue = outputKind === 'text' ? 'chat' : 'media'
  const repository = new SupabaseJobRepository()
  let result
  try {
    result = await repository.enqueue({
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
    input: {
      schemaVersion: 1,
      payloadRef: reference.objectKey,
      payloadHash: reference.sha256,
      payloadBytes: reference.bytes,
      payloadContentType: reference.contentType,
      outputKind,
      billingClass: body.endpointId ? 'customer' : 'platform',
      requestId: input.requestId,
    },
    budget: outputKind === 'text' ? {
      wallTimeMs: 10 * 60_000,
      tokenLimit: 160_000,
      toolCallLimit: 64,
    } : {
      wallTimeMs: 15 * 60_000,
      costMicros: 50_000_000,
    },
    priority: 0,
    maxAttempts: outputKind === 'text' ? 3 : 2,
    })
  } catch (error) {
    // Preserve a payload if the database accepted the job but the response was
    // lost. Only compensate a proven non-enqueue; otherwise cleanup owns it.
    const admin = createAdminClient()
    const accepted = admin
      ? await admin.from('jobs').select('id').eq('id', body.generationId).maybeSingle()
      : null
    if (accepted && !accepted.error && !accepted.data) {
      await removeJobPayload(reference, {
        userId: input.userId, jobId: body.generationId,
      }).catch(() => undefined)
    }
    throw error
  }
  if (result.created) jobMetrics.recordEnqueued(outputKind === 'text' ? 'chat_generation'
    : outputKind === 'image' ? 'media_image' : 'media_video')
  return result
}
