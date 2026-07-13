import type { NextRequest } from "next/server"
import { isIP } from "node:net"

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/
const localRequestIds = new WeakMap<Request, string>()

export class RequestError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = "RequestError"
  }
}

export async function readJson<T = Record<string, unknown>>(
  request: Request,
  options: { maxBytes?: number } = {},
): Promise<T> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BODY_BYTES
  const declaredLength = Number(request.headers.get("content-length"))
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new RequestError(413, "请求内容过大")
  }
  if (!request.body) throw new RequestError(400, "请求体为空")

  const reader = request.body.getReader()
  const decoder = new TextDecoder()
  let totalBytes = 0
  let text = ""

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      totalBytes += value.byteLength
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw new RequestError(413, "请求内容过大")
      }
      text += decoder.decode(value, { stream: true })
    }
    text += decoder.decode()
  } finally {
    reader.releaseLock()
  }

  if (!text.trim()) throw new RequestError(400, "请求体为空")
  try {
    return JSON.parse(text) as T
  } catch {
    throw new RequestError(400, "请求体格式错误")
  }
}

export function requestErrorResponse(error: unknown): Response {
  if (error instanceof RequestError) {
    return Response.json({ error: error.message }, { status: error.status })
  }
  return Response.json({ error: "请求体格式错误" }, { status: 400 })
}

export function clientAddress(request: NextRequest | Request): string {
  // Render guarantees the first X-Forwarded-For entry is the real client IP.
  // Do not accept caller-controlled alternative IP headers as identity input.
  const value = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
  return value && isIP(value) ? value : "unknown"
}

export function requestId(request: NextRequest | Request): string {
  const forwarded = request.headers.get("x-request-id")?.trim()
  if (forwarded && REQUEST_ID_PATTERN.test(forwarded)) return forwarded
  const existing = localRequestIds.get(request)
  if (existing) return existing
  const generated = crypto.randomUUID()
  localRequestIds.set(request, generated)
  return generated
}
