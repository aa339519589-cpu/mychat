import { NextRequest } from "next/server"
import {
  handleChatGptLongThinkRpc,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "@/lib/chatgpt-long-think/mcp"

const MAX_BODY_BYTES = 256 * 1024

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  })
}

function invalidRequest(id: string | number | null = null): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid Request" } }
}

async function readBody(request: NextRequest): Promise<unknown> {
  const length = Number(request.headers.get("content-length") ?? "0")
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) throw new Error("request_too_large")
  const raw = await request.text()
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) throw new Error("request_too_large")
  return raw ? JSON.parse(raw) : null
}

function handleOne(value: unknown): JsonRpcResponse | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalidRequest()
  return handleChatGptLongThinkRpc(value as JsonRpcRequest)
}

export async function POST(request: NextRequest): Promise<Response> {
  let body: unknown
  try {
    body = await readBody(request)
  } catch (error) {
    if (error instanceof Error && error.message === "request_too_large") {
      return json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Request too large" } }, 413)
    }
    return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400)
  }

  if (Array.isArray(body)) {
    if (body.length === 0) return json(invalidRequest(), 400)
    const results = body.map(handleOne).filter((item): item is JsonRpcResponse => item !== null)
    return results.length > 0 ? json(results) : new Response(null, { status: 202 })
  }

  const result = handleOne(body)
  return result ? json(result) : new Response(null, { status: 202 })
}

export async function GET(): Promise<Response> {
  return new Response(null, {
    status: 405,
    headers: {
      allow: "POST",
      "cache-control": "no-store",
    },
  })
}

export async function DELETE(): Promise<Response> {
  return GET()
}

export async function OPTIONS(): Promise<Response> {
  return new Response(null, {
    status: 204,
    headers: {
      allow: "POST, OPTIONS",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type, accept, mcp-protocol-version, mcp-session-id",
      "access-control-max-age": "86400",
    },
  })
}
