import {
  codeContextPolicy,
  trimCodeContextMessages,
  type CodeAgentMode,
} from '@/lib/code-agent/context'
import type { CodeChatMessage } from '@/lib/code-agent/request'
import type { SupabaseClient } from '@/lib/supabase/types'
import { JobRuntimeError } from '../errors'

type MessageIdentity = {
  userId: string
  sessionId: string
  userMessageId: string
}

type MessageSource = {
  created_at: string
}

export async function loadAgentMessageHistory(
  client: SupabaseClient,
  value: MessageIdentity,
  source: MessageSource,
  mode: CodeAgentMode,
): Promise<CodeChatMessage[]> {
  const policy = codeContextPolicy(mode)
  const { data, error } = await client.from('code_messages')
    .select('id,role,content,created_at').eq('session_id', value.sessionId)
    .eq('user_id', value.userId).in('role', ['user', 'assistant'])
    .lte('created_at', source.created_at)
    .order('created_at', { ascending: false }).order('id', { ascending: false })
    .limit(policy.messages)
  if (error) throw new JobRuntimeError('JOB_DEPENDENCY_UNAVAILABLE', 'Agent messages are unavailable')
  const rows = data ?? []
  if (!rows.length || !rows.some(row => row.id === value.userMessageId)) {
    throw new JobRuntimeError('JOB_NOT_FOUND', 'Agent user message does not exist')
  }
  const messages = rows.flatMap(row => (
    (row.role === 'user' || row.role === 'assistant') && typeof row.content === 'string'
      ? [{ role: row.role, content: row.content } as CodeChatMessage]
      : []
  )).reverse()
  return trimCodeContextMessages(messages, mode)
}
