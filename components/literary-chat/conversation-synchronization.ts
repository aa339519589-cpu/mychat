type SynchronizationOptions = {
  hydrate: () => Promise<void>
  reconcile: () => Promise<boolean>
  isCancelled: () => boolean
  sleep?: (ms: number) => Promise<void>
  retryDelayMs?: (attempt: number) => number
  maxAttempts?: number
}

const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/**
 * Fresh history is the foreground authority gate. Generation reconciliation is
 * retried briefly, then allowed to recover in the background so a transient job
 * status outage can never leave the composer locked forever.
 */
export async function synchronizeConversationState({
  hydrate,
  reconcile,
  isCancelled,
  sleep = defaultSleep,
  retryDelayMs = attempt => Math.min(4_000, 400 * (2 ** attempt)),
  maxAttempts = 3,
}: SynchronizationOptions): Promise<boolean> {
  let hydrated = false
  for (let attempt = 0; attempt < Math.max(1, maxAttempts) && !isCancelled(); attempt++) {
    try {
      if (!hydrated) {
        await hydrate()
        hydrated = true
      }
      if (isCancelled()) return false
      if (await reconcile()) return true
    } catch (error) {
      console.warn('[mychat/generation] conversation synchronization unavailable', {
        attempt: attempt + 1,
        error: error instanceof Error ? error.name : 'unknown',
      })
    }
    if (isCancelled()) return false
    if (attempt + 1 < Math.max(1, maxAttempts)) await sleep(retryDelayMs(attempt))
  }
  return hydrated && !isCancelled()
}
