import { RequestError } from '@/lib/api/request'
import type { ModelCatalogItem } from '@/lib/model-catalog'

export type ChatModelPolicy = 'claude-only'

export function usageLimitMessage(policy: ChatModelPolicy | undefined, legacyMessage: string): string {
  return policy === 'claude-only'
    ? 'Your available Claude usage has been reached. Please check your account usage before trying again.'
    : legacyMessage
}

export function catalogForModelPolicy(models: ModelCatalogItem[], policy: ChatModelPolicy | undefined): ModelCatalogItem[] {
  return policy === 'claude-only'
    ? models.filter(model => isClaudeModelId(model.id) && model.provider === 'Anthropic' && model.outputKind === 'chat')
    : models
}

export function isClaudeModelId(value: unknown): value is string {
  return typeof value === 'string'
    && /^anthropic\/claude-(?:fable|opus|sonnet|haiku)-\d+(?:\.\d+)*$/.test(value)
}

/** Product policy is separate from renderer capability and never supplies a default model. */
export function validateChatModelPolicy(body: { modelPolicy?: unknown; modelId?: unknown; endpointId?: unknown }): void {
  if (body.modelPolicy === undefined) return
  if (body.modelPolicy !== 'claude-only') throw new RequestError(400, 'modelPolicy 无效')
  if (!isClaudeModelId(body.modelId) || body.endpointId !== undefined) {
    throw new RequestError(400, 'Choose an available Claude model. Other models and custom endpoints are not supported in this app.')
  }
}
