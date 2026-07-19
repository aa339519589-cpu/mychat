import type { SupabaseClient } from '@/lib/supabase/types'
import { normalizeCustomSystemPrompt } from '@/lib/user-system-prompt'

export async function loadCustomSystemPrompt(
  client: SupabaseClient,
  userId: string,
): Promise<string> {
  const result = await client.from('profiles').select('custom_system_prompt')
    .eq('user_id', userId).maybeSingle()
  if (result.error) throw new Error('用户系统提示词暂时不可用', { cause: result.error })
  return normalizeCustomSystemPrompt(result.data?.custom_system_prompt)
}
