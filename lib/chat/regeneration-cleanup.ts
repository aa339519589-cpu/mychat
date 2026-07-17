import type { SupabaseClient } from '@/lib/supabase/types'
import type { ChatRegenerationAuthority } from '@/lib/llm/chat-request'
import { generatedMediaObjectKeys } from '@/lib/chat/history-deletion'
import { JobRuntimeError } from '@/lib/jobs/errors'
import { resolveAdminConfig } from '@/lib/supabase/admin'

const MAX_REPLACED_MESSAGES = 500

type StoredMessage = {
  id: string
  conversation_id: string
  images: unknown
  seq: number
}

function storageOrigin(): string {
  const configured = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || resolveAdminConfig()?.url
  try {
    if (!configured) throw new Error('missing')
    return new URL(configured).origin
  } catch {
    throw new JobRuntimeError('JOB_DEPENDENCY_UNAVAILABLE', 'Generated media cleanup authority is unavailable')
  }
}

export async function loadRegenerationCleanupKeys(input: {
  client: SupabaseClient
  userId: string
  conversationId: string
  sourceUserMessageId: string
  authority: ChatRegenerationAuthority
  storageOrigin?: string
}): Promise<string[]> {
  const { data: source, error: sourceError } = await input.client
    .from('messages')
    .select('seq')
    .eq('id', input.sourceUserMessageId)
    .eq('conversation_id', input.conversationId)
    .eq('user_id', input.userId)
    .eq('role', 'user')
    .maybeSingle()
  if (sourceError) {
    throw new JobRuntimeError('JOB_DEPENDENCY_UNAVAILABLE', 'Regeneration source lookup failed')
  }
  if (!source || !Number.isSafeInteger(source.seq)) {
    throw new JobRuntimeError('JOB_CONFLICT', 'Regeneration source no longer exists')
  }

  let query = input.client
    .from('messages')
    .select('id,conversation_id,images,seq')
    .eq('conversation_id', input.conversationId)
    .eq('user_id', input.userId)
  query = input.authority.operation === 'replace-assistant'
    ? query.eq('id', input.authority.targetAssistantMessageId as string)
    : query.gt('seq', source.seq).order('seq', { ascending: true }).limit(MAX_REPLACED_MESSAGES + 1)
  const { data, error } = await query
  if (error || !data) {
    throw new JobRuntimeError('JOB_DEPENDENCY_UNAVAILABLE', 'Regeneration branch lookup failed')
  }
  if (data.length > MAX_REPLACED_MESSAGES) {
    throw new JobRuntimeError('JOB_CONFLICT', 'Regeneration branch is too large')
  }
  return generatedMediaObjectKeys(
    data as StoredMessage[], input.userId, input.storageOrigin ?? storageOrigin(),
  )
}
