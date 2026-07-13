type SynchronizationOptions = {
  hydrate: () => Promise<void>
  reconcile: () => Promise<boolean>
  isCancelled: () => boolean
  sleep?: (ms: number) => Promise<void>
  retryDelayMs?: (attempt: number) => number
}

const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/** Keep history locked until both the fresh message read and generation snapshot succeed. */
export async function synchronizeConversationState({
  hydrate,
  reconcile,
  isCancelled,
  sleep = defaultSleep,
  retryDelayMs = attempt => Math.min(8_000, 500 * (2 ** attempt)),
}: SynchronizationOptions): Promise<boolean> {
  let attempt = 0
  while (!isCancelled()) {
    try {
      await hydrate()
      if (isCancelled()) return false
      if (await reconcile()) return true
    } catch (error) {
      console.warn('[mychat/generation] conversation synchronization unavailable', {
        attempt: attempt + 1,
        error: error instanceof Error ? error.name : 'unknown',
      })
    }
    if (isCancelled()) return false
    await sleep(retryDelayMs(attempt))
    attempt += 1
  }
  return false
}
