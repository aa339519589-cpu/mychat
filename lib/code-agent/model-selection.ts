import type { SupabaseServer } from '@/lib/api/guard'
import {
  ChatModelSelectionError,
  resolveChatModelSelection,
  type ChatModelSelection,
} from '@/lib/chat/model-selection'
import { getDirectDeepSeekCatalogRoute } from '@/lib/llm/models'
import { getOpenRouterModel } from '@/lib/openrouter-catalog'

const DIRECT_DEEPSEEK_RUNTIME_MODELS: Readonly<Record<string, string>> = {
  'deepseek-v4-flash': 'deepseek/deepseek-v4-flash-0731',
  'deepseek-v4-pro': 'deepseek/deepseek-v4-pro',
}

/** Accept both the public catalog ID and the persisted provider runtime ID. */
export function codeCatalogModelId(modelId: string): string {
  return DIRECT_DEEPSEEK_RUNTIME_MODELS[modelId] ?? modelId
}

export async function resolveCodeModelSelection(options: {
  modelId: string
  reasoningEffort?: string
  supabase: SupabaseServer | null
  userId: string | null
  allowPremium?: boolean
}): Promise<ChatModelSelection> {
  const modelId = codeCatalogModelId(options.modelId)
  const directDeepSeek = getDirectDeepSeekCatalogRoute(modelId)
  if (!directDeepSeek) {
    const catalogModel = await getOpenRouterModel(modelId)
    if (!catalogModel) {
      throw new ChatModelSelectionError(404, { error: '该模型当前未在 OpenRouter 提供' })
    }
    if (catalogModel.outputKind !== 'chat') {
      throw new ChatModelSelectionError(409, { error: 'Code 仅支持文本模型' })
    }
    if (!catalogModel.tools) {
      throw new ChatModelSelectionError(409, { error: '该模型不支持 Code 所需的函数调用' })
    }
  }
  return resolveChatModelSelection({
    tier: '绝句',
    modelId,
    reasoningEffort: options.reasoningEffort,
    supabase: options.supabase,
    userId: options.userId,
    allowPremium: options.allowPremium,
  })
}
