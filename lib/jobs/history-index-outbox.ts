import type { SupabaseServer } from '@/lib/api/guard'
import { refreshChatHistoryIndex } from '@/lib/chat/history'
import type { SupabaseClient } from '@/lib/supabase/types'
import { isRecord } from '@/lib/unknown-value'
import { JobRuntimeError } from './errors'
import type { JobOutboxMessage } from './outbox-contracts'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function consumeHistoryIndexOutbox(input: {
  client: SupabaseClient
  message: JobOutboxMessage
  verifyAuthority: () => Promise<void>
  refresh?: typeof refreshChatHistoryIndex
}): Promise<void> {
  const { client, message } = input
  const conversationId = message.payload.conversationId
  if (message.topic !== 'history.index' || typeof conversationId !== 'string' || !UUID_PATTERN.test(conversationId)) {
    throw new JobRuntimeError('JOB_INVALID_INPUT', 'History indexing scope is malformed')
  }
  // Payloads cannot pick another conversation or principal. Finalization owns
  // the topic, and only this completed chat Job's authoritative subject is read.
  const { data: job, error } = await client.from('jobs').select('type,status,subject,principal_id')
    .eq('id', message.jobId).eq('principal_id', message.principalId).maybeSingle()
  if (error) throw new JobRuntimeError('JOB_DEPENDENCY_UNAVAILABLE', 'History indexing source is unavailable')
  if (!job || job.type !== 'chat.generation' || job.status !== 'completed'
    || job.principal_id !== message.principalId || !isRecord(job.subject)
    || job.subject.conversationId !== conversationId) {
    throw new JobRuntimeError('JOB_INVALID_INPUT', 'History indexing source scope does not match')
  }
  await input.verifyAuthority()
  await (input.refresh ?? refreshChatHistoryIndex)({
    supabase: client as SupabaseServer, userId: message.principalId, conversationId,
    strict: true, beforeWrite: input.verifyAuthority,
  })
}
