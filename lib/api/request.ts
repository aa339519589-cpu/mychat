import type { NextRequest } from "next/server"

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024

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
  const headers = request.headers
  const candidates = [
    headers.get("cf-connecting-ip"),
    headers.get("x-real-ip"),
    headers.get("x-forwarded-for")?.split(",")[0],
  ]
  const value = candidates.find(candidate => candidate?.trim())?.trim()
  return value?.slice(0, 128) || "unknown"
}
