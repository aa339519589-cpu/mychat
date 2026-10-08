import type { SupabaseClient } from '@/lib/supabase/types'
import { normalizeCustomSystemPrompt } from '@/lib/user-system-prompt'
import type { MemoryPreferences } from './authoritative-context-memory'

export async function loadChatUserProfile(client: SupabaseClient, userId: string): Promise<{
  customSystemPrompt: string
  preferences: MemoryPreferences
}> {
  const result = await client.from('profiles').select('user_id,custom_system_prompt,memory_enabled,sensitive_memory_enabled')
    .eq('user_id', userId).maybeSingle()
  if (result.error || (result.data?.user_id && result.data.user_id !== userId)) {
    throw new Error('用户上下文暂时不可用')
  }
  return { customSystemPrompt: normalizeCustomSystemPrompt(result.data?.custom_system_prompt),
    preferences: { enabled: result.data?.memory_enabled !== false, sensitiveEnabled: result.data?.sensitive_memory_enabled === true } }
}

export async function loadCustomSystemPrompt(
  client: SupabaseClient,
  userId: string,
): Promise<string> {
  const result = await client.from('profiles').select('custom_system_prompt')
    .eq('user_id', userId).maybeSingle()
  if (result.error) throw new Error('用户系统提示词暂时不可用', { cause: result.error })
  return normalizeCustomSystemPrompt(result.data?.custom_system_prompt)
}
