export type TimedJsonResponse = {
  response: Response
  payload: unknown
}

export class RequestTimeoutError extends Error {
  constructor() {
    super('request_timeout')
    this.name = 'RequestTimeoutError'
  }
}

export async function fetchWithTimeout(
  fetcher: typeof fetch,
  input: RequestInfo | URL,
  init: RequestInit,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<Response> {
  if (signal.aborted) throw signal.reason ?? new Error('请求已取消')
  const controller = new AbortController()
  let timeout: ReturnType<typeof setTimeout> | null = null
  let detachAbort = () => undefined
  const cancellation = new Promise<never>((_resolve, reject) => {
    const abort = () => {
      controller.abort(signal.reason)
      reject(signal.reason ?? new Error('请求已取消'))
    }
    detachAbort = () => {
      signal.removeEventListener('abort', abort)
      return undefined
    }
    signal.addEventListener('abort', abort, { once: true })
    timeout = setTimeout(() => {
      const error = new RequestTimeoutError()
      controller.abort(error)
      reject(error)
    }, Math.max(1, timeoutMs))
  })
  try {
    const request = fetcher(input, { ...init, signal: controller.signal })
    return await Promise.race([request, cancellation])
  } finally {
    if (timeout) clearTimeout(timeout)
    detachAbort()
  }
}

export async function fetchJsonWithTimeout(
  fetcher: typeof fetch,
  input: RequestInfo | URL,
  init: RequestInit,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<TimedJsonResponse> {
  const response = await fetchWithTimeout(fetcher, input, init, signal, timeoutMs)
  const payload: unknown = await response.json().catch(() => null)
  return { response, payload }
}
