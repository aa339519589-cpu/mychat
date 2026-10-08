import { WorkspaceDiffError } from './workspace-text-diff'

export type DiffFetch = (url: string, init: RequestInit) => Promise<Response>

function checkMaximum(maximum: number): void {
  if (!Number.isSafeInteger(maximum) || maximum < 0 || maximum > 4 * 1024 * 1024) {
    throw new WorkspaceDiffError('INVALID_LIMIT', 'Invalid diff download limit')
  }
}

async function rejectResponse(response: Response, code: string, message: string): Promise<never> {
  await response.body?.cancel().catch(() => undefined)
  throw new WorkspaceDiffError(code, message)
}

export async function boundedDiffBody(response: Response, maximum: number,
  signal: AbortSignal = new AbortController().signal): Promise<Buffer> {
  checkMaximum(maximum)
  if (signal.aborted) {
    await response.body?.cancel().catch(() => undefined)
    signal.throwIfAborted()
  }
  const declared = response.headers.get('content-length')
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximum)) {
    return rejectResponse(response, 'BODY_LIMIT', 'The response exceeds the diff transfer limit')
  }
  if (!response.body) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let count = 0
  const abort = () => { void reader.cancel().catch(() => undefined) }
  signal.addEventListener('abort', abort, { once: true })
  try {
    signal.throwIfAborted()
    while (true) {
      const result = await reader.read()
      signal.throwIfAborted()
      if (result.done) break
      count += 1
      total += result.value.byteLength
      if (total > maximum || count > 8192) {
        await reader.cancel().catch(() => undefined)
        throw new WorkspaceDiffError('BODY_LIMIT', 'The response exceeds the diff transfer limit')
      }
      chunks.push(result.value.slice())
    }
    return Buffer.concat(chunks, total)
  } finally {
    signal.removeEventListener('abort', abort)
    reader.releaseLock()
  }
}

export async function boundedDiffGet(url: string, headers: Record<string, string>, maximum: number,
  signal: AbortSignal, fetcher: DiffFetch): Promise<Buffer> {
  checkMaximum(maximum)
  signal.throwIfAborted()
  const response = await fetcher(url, { method: 'GET', headers, signal, redirect: 'error',
    credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' })
  if (response.redirected || (response.status >= 300 && response.status < 400)
      || (response.url && response.url !== url)) {
    return rejectResponse(response, 'UNSAFE_REDIRECT', 'Diff downloads must not follow redirects or change origin')
  }
  if (!response.ok) return rejectResponse(response, 'READ_UNAVAILABLE', `Diff source returned HTTP ${response.status}`)
  return boundedDiffBody(response, maximum, signal)
}

export function diffReadSignal(signal: AbortSignal | undefined, timeout: number): AbortSignal {
  const deadline = AbortSignal.timeout(timeout)
  return signal ? AbortSignal.any([signal, deadline]) : deadline
}
