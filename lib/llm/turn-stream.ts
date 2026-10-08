import {
  GenericResponseLimitError,
  MAX_GENERIC_SUCCESS_RESPONSE_BYTES,
  declaredResponseBytes,
  readLimitedResponseText,
} from "./turn-response"

export class CallerOutputLimitReached extends Error {
  constructor() {
    super("Caller output limit reached")
    this.name = "CallerOutputLimitReached"
  }
}

type ConsumeResult = {
  sawDone: boolean
  callerLimitReached: boolean
}

function handlePayload(payload: string, handle: (value: unknown) => void): boolean {
  let value: unknown
  try { value = JSON.parse(payload) } catch { return false }
  // Invalid JSON framing is ignorable; handler failures are not. Silencing a
  // budget/provider/application error can leave the request open indefinitely.
  handle(value)
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && ['message_stop', 'error'].includes(String((value as { type?: unknown }).type)))
}

function handleSseLine(rawLine: string, handle: (value: unknown) => void): boolean {
  const line = rawLine.trim()
  if (!line) return false
  if (line === 'data: [DONE]') return true
  const payload = line.startsWith('data:') ? line.slice(5).trim() : line
  return payload.length > 0 && handlePayload(payload, handle)
}

export async function consumeTurnResponse(
  response: Response,
  generic: boolean,
  handle: (value: unknown) => void,
): Promise<ConsumeResult> {
  if (response.headers.get("content-type")?.includes("application/json")) {
    try {
      const payload = generic
        ? JSON.parse(await readLimitedResponseText(response, MAX_GENERIC_SUCCESS_RESPONSE_BYTES))
        : await response.json()
      handle(payload)
      return { sawDone: false, callerLimitReached: false }
    } catch (error) {
      if (!(error instanceof CallerOutputLimitReached)) throw error
      return { sawDone: true, callerLimitReached: true }
    }
  }

  const body = response.body
  if (!body) return { sawDone: false, callerLimitReached: false }
  const declared = declaredResponseBytes(response)
  if (generic && declared !== null && declared > MAX_GENERIC_SUCCESS_RESPONSE_BYTES) {
    await body.cancel().catch(() => undefined)
    throw new GenericResponseLimitError()
  }

  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let responseBytes = 0
  let sawDone = false
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (generic) {
        responseBytes += value.byteLength
        if (responseBytes > MAX_GENERIC_SUCCESS_RESPONSE_BYTES) throw new GenericResponseLimitError()
      }
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ""
      for (const rawLine of lines) {
        if (handleSseLine(rawLine, handle)) {
          await reader.cancel().catch(() => undefined)
          return { sawDone: true, callerLimitReached: false }
        }
      }
    }

    buffer += decoder.decode()
    sawDone = handleSseLine(buffer, handle)
    return { sawDone, callerLimitReached: false }
  } catch (error) {
    if (error instanceof CallerOutputLimitReached) {
      await reader.cancel().catch(() => undefined)
      return { sawDone: true, callerLimitReached: true }
    }
    if (generic && error instanceof GenericResponseLimitError) {
      await reader.cancel().catch(() => undefined)
    }
    throw error
  } finally {
    reader.releaseLock()
  }
}
