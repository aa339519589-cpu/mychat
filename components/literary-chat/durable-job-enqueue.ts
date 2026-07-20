import {
  enqueueJob,
  isRetryableEnqueueError,
  type AcceptedJob,
  type EnqueueJobError,
} from './job-stream-client'

const RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const

type DurableEnqueueDependencies = {
  enqueue: typeof enqueueJob
  sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>
}

function abortableWait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason)
    const timer = setTimeout(resolve, milliseconds)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(signal.reason)
    }, { once: true })
  })
}

/** Keep resubmitting the exact idempotent command until accepted or stopped. */
export async function enqueueJobUntilAccepted(
  path: string,
  body: unknown,
  signal: AbortSignal,
  onRetrying?: (error: EnqueueJobError) => void,
  dependencyOverrides: Partial<DurableEnqueueDependencies> = {},
): Promise<AcceptedJob> {
  const enqueue = dependencyOverrides.enqueue ?? enqueueJob
  const sleep = dependencyOverrides.sleep ?? abortableWait
  let retry = 0
  while (!signal.aborted) {
    try {
      return await enqueue(path, body, signal)
    } catch (error) {
      if (!isRetryableEnqueueError(error)) throw error
      onRetrying?.(error)
      const delay = RETRY_DELAYS_MS[Math.min(retry, RETRY_DELAYS_MS.length - 1)]
      retry += 1
      await sleep(delay, signal)
    }
  }
  throw signal.reason ?? new DOMException('Aborted', 'AbortError')
}
