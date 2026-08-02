type SynchronizationOptions = {
  hydrate: () => Promise<void>
  reconcile: () => Promise<boolean>
  isCancelled: () => boolean
}

/**
 * Fresh history is the only foreground authority gate. Generation recovery is
 * best-effort and must never keep the composer locked behind retry backoff.
 */
export async function synchronizeConversationState({
  hydrate,
  reconcile,
  isCancelled,
}: SynchronizationOptions): Promise<boolean> {
  try {
    await hydrate()
  } catch (error) {
    console.warn('[mychat/generation] conversation hydration unavailable', {
      error: error instanceof Error ? error.name : 'unknown',
    })
    return false
  }

  if (isCancelled()) return false

  // Resume/status reconciliation can be slow or temporarily unavailable.
  // Run it once in the background; message hydration has already established
  // the conversation state, so the input must be released immediately.
  void reconcile().catch(error => {
    console.warn('[mychat/generation] conversation reconciliation unavailable', {
      error: error instanceof Error ? error.name : 'unknown',
    })
  })

  return true
}
