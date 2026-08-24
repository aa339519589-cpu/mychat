import { NextRequest } from "next/server"
import { resolveAuth } from "@/lib/api/guard"
import { handleMaestroRpc } from "@/lib/maestro/mcp"

const MAX_BODY_BYTES = 512 * 1024

type RpcResponse = Awaited<ReturnType<typeof handleMaestroRpc>>

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  })
}

async function body(request: NextRequest): Promise<unknown> {
  const length = Number(request.headers.get("content-length") ?? "0")
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) throw new Error("too_large")
  const raw = await request.text()
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) throw new Error("too_large")
  return raw ? JSON.parse(raw) : null
}

async function handleOne(value: unknown, origin: string, userId: string | null): Promise<RpcResponse> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } }
  }
  return handleMaestroRpc(value, { origin, userId })
}

export async function POST(request: NextRequest): Promise<Response> {
  let value: unknown
  try { value = await body(request) }
  catch (error) {
    const tooLarge = error instanceof Error && error.message === "too_large"
    return json({ jsonrpc: "2.0", id: null, error: { code: tooLarge ? -32600 : -32700, message: tooLarge ? "Request too large" : "Parse error" } }, tooLarge ? 413 : 400)
  }

  const origin = new URL(request.url).origin
  const auth = await resolveAuth(request)
  const userId = auth.userId ?? null

  if (Array.isArray(value)) {
    if (value.length === 0) return json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } }, 400)
    const responses = (await Promise.all(value.map(item => handleOne(item, origin, userId)))).filter((item): item is Exclude<RpcResponse, null> => item !== null)
    return responses.length ? json(responses) : new Response(null, { status: 202 })
  }
  const response = await handleOne(value, origin, userId)
  return response ? json(response) : new Response(null, { status: 202 })
}

export async function GET(): Promise<Response> {
  return new Response(null, { status: 405, headers: { allow: "POST, OPTIONS", "cache-control": "no-store" } })
}

export async function OPTIONS(): Promise<Response> {
  return new Response(null, {
    status: 204,
    headers: {
      allow: "POST, OPTIONS",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "authorization, content-type, accept, mcp-protocol-version, mcp-session-id",
      "access-control-max-age": "86400",
    },
  })
}
