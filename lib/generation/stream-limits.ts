export const MAX_CONCURRENT_GENERATION_STREAMS_PER_USER = 4
export const GENERATION_STREAM_CONNECTIONS_PER_MINUTE = 30

type GenerationStreamPermit =
  | { acquired: false }
  | { acquired: true; release: () => void }

const globalStreamLimits = globalThis as typeof globalThis & {
  __mychatGenerationStreamCounts?: Map<string, number>
}

const activeStreams = globalStreamLimits.__mychatGenerationStreamCounts
  ?? (globalStreamLimits.__mychatGenerationStreamCounts = new Map())

/**
 * Per-process backstop for long-lived SSE connections. Distributed admission
 * rate limiting is enforced separately before this permit is acquired.
 */
export function acquireGenerationStreamPermit(
  userId: string,
  limit = MAX_CONCURRENT_GENERATION_STREAMS_PER_USER,
): GenerationStreamPermit {
  const boundedLimit = Math.max(1, Math.floor(limit))
  const current = activeStreams.get(userId) ?? 0
  if (current >= boundedLimit) return { acquired: false }

  activeStreams.set(userId, current + 1)
  let released = false
  return {
    acquired: true,
    release() {
      if (released) return
      released = true
      const latest = activeStreams.get(userId) ?? 0
      if (latest <= 1) activeStreams.delete(userId)
      else activeStreams.set(userId, latest - 1)
    },
  }
}
