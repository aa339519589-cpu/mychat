import type { SupabaseClient } from '@supabase/supabase-js'
import type { SupabaseServer } from '@/lib/api/guard'
import { generateTitleText } from '@/lib/chat/title-generation'
import { resolveChatModelSelection } from '@/lib/chat/model-selection'
import { weightedTokenUsage } from '@/lib/quota'
import { createAdminClient } from '@/lib/supabase/admin'
import type { JobHandler } from '../worker'
import { JobRuntimeError } from '../errors'

function stringField(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value) throw new JobRuntimeError('JOB_INVALID_INPUT', `Missing ${name}`)
  return value
}

function rowText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value.flatMap(part => part && typeof part === 'object' && !Array.isArray(part)
    && typeof (part as { text?: unknown }).text === 'string' ? [(part as { text: string }).text] : []).join('\n')
}

export const handleChatTitle: JobHandler = async context => {
  let client: SupabaseClient | null
  try { client = createAdminClient() } catch (error) {
    throw new JobRuntimeError('JOB_DEPENDENCY_UNAVAILABLE', 'Database authority is unavailable', { cause: error })
  }
  if (!client) throw new JobRuntimeError('JOB_DEPENDENCY_UNAVAILABLE', 'Database authority is unavailable')
  const conversationId = stringField(context.job.subject.conversationId, 'conversationId')
  const sourceMessageId = stringField(context.job.subject.sourceMessageId, 'sourceMessageId')
  const payload = context.job.input && typeof context.job.input === 'object' && !Array.isArray(context.job.input)
    ? context.job.input as Record<string, unknown> : {}
  const endpointId = typeof payload.endpointId === 'string' ? payload.endpointId : undefined
  const { data: assistant, error: assistantError } = await client.from('messages')
    .select('id,seq,content,content_parts').eq('id', sourceMessageId)
    .eq('conversation_id', conversationId).eq('user_id', context.job.principal.id)
    .eq('role', 'assistant').eq('status', 'terminal').maybeSingle()
  if (assistantError) throw new JobRuntimeError('JOB_DEPENDENCY_UNAVAILABLE', 'Title source is unavailable')
  if (!assistant) throw new JobRuntimeError('JOB_NOT_FOUND', 'Title source message does not exist')
  const { data: user, error: userError } = await client.from('messages')
    .select('content,content_parts').eq('conversation_id', conversationId)
    .eq('user_id', context.job.principal.id).eq('role', 'user')
    .lte('seq', assistant.seq).order('seq', { ascending: false }).limit(1).maybeSingle()
  if (userError) throw new JobRuntimeError('JOB_DEPENDENCY_UNAVAILABLE', 'Title source is unavailable')
  if (!user) throw new JobRuntimeError('JOB_NOT_FOUND', 'Title user message does not exist')
  const selection = await resolveChatModelSelection({
    tier: '绝句', deepResearch: false, endpointId,
    supabase: client as unknown as SupabaseServer,
    userId: context.job.principal.id,
  })
  const result = await generateTitleText({
    request: {
      conversationId,
      userText: rowText(user.content_parts) || rowText(user.content),
      assistantText: rowText(assistant.content_parts) || rowText(assistant.content),
      ...(endpointId ? { endpointId } : {}),
    },
    selection,
    signal: context.signal,
    idempotencyNamespace: context.job.id,
  })
  context.assertAuthority()
  return {
    status: 'completed',
    result: { schemaVersion: 1, title: result.title },
    ledgerEntries: result.totalTokens > 0 ? [{
      idempotencyKey: `${context.job.id}:model-usage`,
      reason: selection.customEndpoint ? 'custom_title_usage' : 'platform_title_usage',
      direction: 'debit',
      weightedTokens: selection.customEndpoint ? 0 : weightedTokenUsage(result.totalTokens, selection.model, false),
      rawTokens: result.totalTokens,
      model: selection.model,
      provider: selection.capability.provider.id,
      metadata: { usingBalance: payload.usingBalance === true },
    }] : [],
  }
}
