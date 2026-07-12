import type { SupabaseClient } from '@supabase/supabase-js'
import { log } from '@/lib/logger'

/** Best-effort DB writes. Missing table/columns must not crash generation. */
export async function persistGenerationRow(
  supabase: SupabaseClient,
  row: {
    id: string
    userId: string
    conversationId: string
    assistantMessageId: string
    status: string
    content: string
    thinking: string
    sequence: number
    error?: string
  },
) {
  try {
    const { error } = await supabase.from('chat_generations').upsert({
      id: row.id,
      user_id: row.userId,
      conversation_id: row.conversationId,
      assistant_message_id: row.assistantMessageId,
      status: row.status,
      content: row.content,
      thinking: row.thinking,
      sequence: row.sequence,
      error: row.error ?? null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'id' })
    if (error) log.warn('generation', 'persist generation row failed', error)
  } catch (e) {
    log.warn('generation', 'persist generation row exception', e)
  }
}

export async function persistAssistantMessage(
  supabase: SupabaseClient,
  assistantMessageId: string,
  fields: { content?: string; thinking?: string | null },
) {
  try {
    const { error } = await supabase.from('messages').update({
      ...(fields.content !== undefined ? { content: fields.content } : {}),
      ...(fields.thinking !== undefined ? { thinking: fields.thinking } : {}),
    }).eq('id', assistantMessageId)
    if (error) log.warn('generation', 'persist message failed', error)
  } catch (e) {
    log.warn('generation', 'persist message exception', e)
  }
}

export async function loadGenerationFromDb(supabase: SupabaseClient, id: string, userId: string) {
  try {
    const { data, error } = await supabase.from('chat_generations')
      .select('*')
      .eq('id', id)
      .eq('user_id', userId)
      .maybeSingle()
    if (error || !data) return null
    return data
  } catch {
    return null
  }
}

export async function loadRunningGenerations(supabase: SupabaseClient, userId: string, conversationId: string) {
  try {
    const { data, error } = await supabase.from('chat_generations')
      .select('*')
      .eq('user_id', userId)
      .eq('conversation_id', conversationId)
      .in('status', ['queued', 'running'])
      .order('created_at', { ascending: false })
      .limit(5)
    if (error || !data) return []
    return data
  } catch {
    return []
  }
}
