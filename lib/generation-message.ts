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
    return '这次回复已中断，请点击重新生成'
  }
  // Backend error codes and control-plane details are operational diagnostics,
  // not useful chat content. Keep them in logs and show one stable recovery path.
  return '这次回复没有生成成功，请点击重新生成'
}
