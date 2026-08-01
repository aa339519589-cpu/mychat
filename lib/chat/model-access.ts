import type { SupabaseServer } from '@/lib/api/guard'
import type { DurableChatRequestBody } from '@/lib/llm/chat-request'

const TRIAL_INPUT_TOKEN_LIMIT = 20_000
const APPROX_CHARS_PER_TOKEN = 3

function messageChars(message: DurableChatRequestBody['messages'][number]): number {
  const content = message.content
  if (typeof content === 'string') return content.length
  if (!Array.isArray(content)) return 0
  return content.reduce((sum, part) => sum + (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string' ? part.text.length : 0), 0)
}

/**
 * Keep the newest durable turn and as much recent history as fits. The server
 * uses a conservative character estimate so provider tokenization cannot push
 * the free request past the 20k input contract.
 */
export function clampTrialInput(body: DurableChatRequestBody): DurableChatRequestBody {
  const budgetChars = TRIAL_INPUT_TOKEN_LIMIT * APPROX_CHARS_PER_TOKEN
  let used = 0
  const kept: DurableChatRequestBody['messages'] = []
  for (let index = body.messages.length - 1; index >= 0; index -= 1) {
    const message = body.messages[index]
    const size = messageChars(message)
    if (kept.length > 0 && used + size > budgetChars) continue
    kept.push(message)
    used += size
    if (used >= budgetChars) break
  }
  kept.reverse()
  const userMessage = kept.find(message => message.id === body.userMessageId)
  if (!userMessage) {
    const source = body.messages.find(message => message.id === body.userMessageId)
    if (source) kept.push(source)
  }
  return { ...body, messages: kept }
}

type TrialReservation = { allowed?: unknown; remaining?: unknown; duplicate?: unknown }

export async function reserveTrialCall(supabase: SupabaseServer, userId: string, generationId: string, modelId: string): Promise<{ allowed: boolean; remaining: number; duplicate: boolean }> {
  const { data, error } = await supabase.rpc('reserve_medium_model_trial', {
    input_principal_id: userId,
    input_generation_id: generationId,
    input_model_id: modelId,
  })
  if (error || !data || typeof data !== 'object' || Array.isArray(data)) throw new Error('中档模型免费额度服务暂时不可用')
  const result = data as TrialReservation
  return {
    allowed: result.allowed === true,
    remaining: typeof result.remaining === 'number' ? Math.max(0, Math.floor(result.remaining)) : 0,
    duplicate: result.duplicate === true,
  }
}

export async function releaseTrialCall(supabase: SupabaseServer, userId: string, generationId: string): Promise<void> {
  await supabase.rpc('release_medium_model_trial', {
    input_principal_id: userId,
    input_generation_id: generationId,
  })
}
