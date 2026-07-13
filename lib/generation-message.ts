import type { MessageGenerationTerminal } from '@/lib/chat-data'

export function normalizeMessageGeneration(value: unknown): MessageGenerationTerminal | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const generation = value as Record<string, unknown>
  if (typeof generation.id !== 'string'
    || (generation.status !== 'completed' && generation.status !== 'failed' && generation.status !== 'cancelled')
    || !Number.isSafeInteger(generation.sequence)
    || Number(generation.sequence) < 0
    || (generation.error !== null && typeof generation.error !== 'string')) return undefined
  return {
    id: generation.id,
    status: generation.status,
    sequence: Number(generation.sequence),
    error: generation.error,
  }
}

export function generationTerminalWarning(
  generation: MessageGenerationTerminal | undefined,
): string | undefined {
  if (generation?.status === 'cancelled') return '已停止生成'
  if (generation?.status !== 'failed') return undefined
  if (generation.error === 'stale_generation_lease_expired') {
    return '生成任务执行租约已失效，请重新生成'
  }
  return generation.error || '生成任务失败'
}
