import type { SupabaseServer } from '@/lib/api/guard'
import {
  ChatModelSelectionError,
  resolveChatModelSelection,
  type ChatModelSelection,
} from '@/lib/chat/model-selection'
import { getOpenRouterModel } from '@/lib/openrouter-catalog'

export async function resolveCodeModelSelection(options: {
  modelId: string
  reasoningEffort?: string
  supabase: SupabaseServer | null
  userId: string | null
  allowPremium?: boolean
}): Promise<ChatModelSelection> {
  const catalogModel = await getOpenRouterModel(options.modelId)
  if (!catalogModel) {
    throw new ChatModelSelectionError(404, { error: '该模型当前未在 OpenRouter 提供' })
  }
  if (catalogModel.outputKind !== 'chat') {
    throw new ChatModelSelectionError(409, { error: 'Code 仅支持文本模型' })
  }
  if (!catalogModel.tools) {
    throw new ChatModelSelectionError(409, { error: '该模型不支持 Code 所需的函数调用' })
  }
  return resolveChatModelSelection({
    tier: '绝句',
    modelId: options.modelId,
    reasoningEffort: options.reasoningEffort,
    supabase: options.supabase,
    userId: options.userId,
    allowPremium: options.allowPremium,
  })
}
