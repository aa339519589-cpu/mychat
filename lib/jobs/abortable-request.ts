export type AbortableRequest<T> = PromiseLike<T> & {
  abortSignal?: (signal: AbortSignal) => PromiseLike<T>
}

export async function awaitAbortableRequest<T>(
  request: AbortableRequest<T>,
  options: {
    timeoutMs: number
    timeoutMessage: string
    signal?: AbortSignal
  },
): Promise<T> {
  const controller = new AbortController()
  const forwardAbort = () => controller.abort(options.signal?.reason)
  if (options.signal?.aborted) forwardAbort()
  else options.signal?.addEventListener('abort', forwardAbort, { once: true })

  const timeout = setTimeout(() => {
    controller.abort(new Error(options.timeoutMessage))
  }, options.timeoutMs)
  const aborted = new Promise<never>((_resolve, reject) => {
    const rejectAbort = () => reject(controller.signal.reason)
    if (controller.signal.aborted) rejectAbort()
    else controller.signal.addEventListener('abort', rejectAbort, { once: true })
  })

  try {
    const operation = typeof request.abortSignal === 'function'
      ? request.abortSignal(controller.signal)
      : request
    return await Promise.race([Promise.resolve(operation), aborted])
  } finally {
    clearTimeout(timeout)
    options.signal?.removeEventListener('abort', forwardAbort)
  }
}
