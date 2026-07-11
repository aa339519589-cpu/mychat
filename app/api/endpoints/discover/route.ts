import { NextRequest } from "next/server"
import { resolveAuth, enforceLimits } from "@/lib/api/guard"
import { readJson, requestErrorResponse } from "@/lib/api/request"
import {
  assertExclusiveStoredEndpointReference,
  discoverOpenAIModels,
  ModelEndpointError,
} from "@/lib/llm/openai-compatible"
import { endpointAuthType, getOwnedModelEndpoint, resolveModelEndpointKey } from "@/lib/model-endpoint-server"
import type { EndpointAuthType } from "@/lib/model-endpoints"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const AUTH_TYPES = new Set(["auto", "bearer", "x-api-key", "api-key", "none"])

function errorResponse(error: unknown): Response {
  if (error instanceof ModelEndpointError) {
    return Response.json({ error: error.message, stage: error.stage, code: error.code }, { status: error.status })
  }
  return Response.json({ error: error instanceof Error ? error.message : "获取模型失败" }, { status: 500 })
}

export async function POST(req: NextRequest) {
  const auth = await resolveAuth()
  if (!auth.supabase || !auth.userId) return Response.json({ error: "请先登录" }, { status: 401 })
  const gate = await enforceLimits(auth, req, { quota: false })
  if (gate.response) return gate.response

  let body: Record<string, unknown>
  try { body = await readJson(req, { maxBytes: 16 * 1024 }) }
  catch (error) { return requestErrorResponse(error) }

  try {
    assertExclusiveStoredEndpointReference(body)
    const hasEndpointId = Object.prototype.hasOwnProperty.call(body, "endpointId")
    if (hasEndpointId && (typeof body.endpointId !== "string" || !UUID.test(body.endpointId))) {
      return Response.json({ error: "端点 ID 无效" }, { status: 400 })
    }
    let baseUrl = typeof body.baseUrl === "string" ? body.baseUrl : ""
    let apiKey = typeof body.apiKey === "string" ? body.apiKey : ""
    let authType = typeof body.authType === "string" ? body.authType : "auto"
    const endpointId = typeof body.endpointId === "string" ? body.endpointId : ""

    if (endpointId) {
      const row = await getOwnedModelEndpoint(auth.supabase, auth.userId, endpointId)
      if (!row) return Response.json({ error: "端点不存在" }, { status: 404 })
      baseUrl = row.base_url
      apiKey = resolveModelEndpointKey(row, auth.userId)
      authType = endpointAuthType(row.auth_type)
    }

    if (baseUrl.length > 2048 || apiKey.length > 4096) return Response.json({ error: "端点配置过长" }, { status: 400 })
    if (!AUTH_TYPES.has(authType)) return Response.json({ error: "鉴权方式无效" }, { status: 400 })

    const result = await discoverOpenAIModels({
      baseUrl,
      apiKey,
      authType: authType as EndpointAuthType | "auto",
      signal: req.signal,
    })
    return Response.json(result)
  } catch (error) {
    return errorResponse(error)
  }
}
