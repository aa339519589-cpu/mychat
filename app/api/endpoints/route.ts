import { NextRequest } from "next/server"
import { resolveAuth, enforceLimits } from "@/lib/api/guard"
import { readJson, requestErrorResponse } from "@/lib/api/request"
import { ModelEndpointError, normalizeOpenAIBaseUrl } from "@/lib/llm/openai-compatible"
import {
  endpointSummary,
  probeModelEndpointAuthentication,
  resolveMediaEndpointConnection,
  type EndpointAuthSelection,
  type ModelEndpointRow,
} from "@/lib/model-endpoint-server"
import { isModelOutputKind, isSafeModelId, modelDisplayName, type EndpointAuthType } from "@/lib/model-endpoints"
import { modelEndpointEncryptionConfigured, sealModelEndpointKey } from "@/lib/model-endpoint-secret"

const AUTH_TYPES = new Set<EndpointAuthSelection>(["auto", "bearer", "x-api-key", "api-key", "none"])

function endpointStorageError(): Response {
  return Response.json({ error: "模型端点存储未就绪，请先执行最新 Supabase migration" }, { status: 503 })
}

function errorResponse(error: unknown): Response {
  if (error instanceof ModelEndpointError) {
    return Response.json({ error: error.message, stage: error.stage, code: error.code }, { status: error.status })
  }
  return Response.json({ error: error instanceof Error ? error.message : "端点连接失败" }, { status: 500 })
}

export async function GET() {
  const auth = await resolveAuth()
  if (!auth.supabase || !auth.userId) return Response.json({ error: "请先登录" }, { status: 401 })
  const { data, error } = await auth.supabase
    .from("endpoints")
    .select("id,user_id,name,protocol,base_url,api_key,model,output_kind,auth_type,created_at,updated_at")
    .eq("user_id", auth.userId)
    .order("updated_at", { ascending: false })
  if (error) return endpointStorageError()
  return Response.json({ endpoints: (data as ModelEndpointRow[] ?? []).map(endpointSummary) })
}

export async function POST(req: NextRequest) {
  const auth = await resolveAuth()
  if (!auth.supabase || !auth.userId) return Response.json({ error: "请先登录" }, { status: 401 })
  const gate = await enforceLimits(auth, req, { quota: false })
  if (gate.response) return gate.response
  if (!modelEndpointEncryptionConfigured()) {
    return Response.json({ error: "端点凭据加密未配置，请设置至少 32 字符的 AGENT_CREDENTIAL_KEY" }, { status: 503 })
  }

  let body: Record<string, unknown>
  try { body = await readJson(req, { maxBytes: 16 * 1024 }) }
  catch (error) { return requestErrorResponse(error) }

  try {
    let baseUrl = normalizeOpenAIBaseUrl(typeof body.baseUrl === "string" ? body.baseUrl : "")
    const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : ""
    const model = typeof body.model === "string" ? body.model.replace(/[\u0000-\u001f\u007f]/g, "").trim() : ""
    if (!isModelOutputKind(body.outputKind)) return Response.json({ error: "请选择模型用途" }, { status: 400 })
    const outputKind = body.outputKind
    if (body.authType !== undefined && (typeof body.authType !== "string" || !AUTH_TYPES.has(body.authType as EndpointAuthSelection))) {
      return Response.json({ error: "鉴权方式无效" }, { status: 400 })
    }
    const requestedAuthType = (body.authType ?? "auto") as EndpointAuthSelection
    if (apiKey.length > 4096 || !isSafeModelId(model, apiKey)) return Response.json({ error: "API Key 或模型 ID 无效；模型字段不能填写 URL 或 API Key" }, { status: 400 })

    let authType: EndpointAuthType
    if (outputKind === "chat") {
      authType = await probeModelEndpointAuthentication({
        baseUrl,
        apiKey,
        authType: requestedAuthType,
        model,
        signal: req.signal,
      })
    } else {
      const connection = await resolveMediaEndpointConnection({ baseUrl, apiKey, authType: requestedAuthType, signal: req.signal })
      baseUrl = connection.baseUrl
      authType = connection.authType
    }

    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    const name = modelDisplayName(model, typeof body.displayName === "string" ? body.displayName : undefined, apiKey)
    const protocol = "openai"
    const encryptedKey = sealModelEndpointKey(apiKey, {
      userId: auth.userId,
      endpointId: id,
      baseUrl,
      protocol,
      authType,
      model,
      outputKind,
    })
    const row = {
      id,
      user_id: auth.userId,
      name,
      protocol,
      base_url: baseUrl,
      api_key: encryptedKey,
      model,
      output_kind: outputKind,
      auth_type: authType,
      updated_at: now,
    }
    const { data, error } = await auth.supabase.from("endpoints").insert(row).select("id,user_id,name,protocol,base_url,api_key,model,output_kind,auth_type,created_at,updated_at").single()
    if (error || !data) return endpointStorageError()
    return Response.json({
      endpoint: endpointSummary(data as ModelEndpointRow),
      verification: { connectionVerified: true, generationVerified: outputKind === "chat" },
    }, { status: 201 })
  } catch (error) {
    return errorResponse(error)
  }
}
