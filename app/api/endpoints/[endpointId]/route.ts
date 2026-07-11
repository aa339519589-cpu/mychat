import { NextRequest } from "next/server"
import { resolveAuth, enforceLimits } from "@/lib/api/guard"
import { readJson, requestErrorResponse } from "@/lib/api/request"
import {
  ModelEndpointError,
  normalizeOpenAIBaseUrl,
  resolveEndpointPatchApiKey,
} from "@/lib/llm/openai-compatible"
import {
  endpointAuthType,
  endpointSummary,
  getOwnedModelEndpoint,
  probeModelEndpointAuthentication,
  resolveMediaEndpointConnection,
  resolveModelEndpointKey,
  type EndpointAuthSelection,
  type ModelEndpointRow,
} from "@/lib/model-endpoint-server"
import { isKnownTextOnlyModel, isModelOutputKind, isSafeModelId, modelDisplayName, type EndpointAuthType } from "@/lib/model-endpoints"
import { sealModelEndpointKey } from "@/lib/model-endpoint-secret"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const AUTH_TYPES = new Set<EndpointAuthSelection>(["auto", "bearer", "x-api-key", "api-key", "none"])

function errorResponse(error: unknown): Response {
  if (error instanceof ModelEndpointError) {
    return Response.json({ error: error.message, stage: error.stage, code: error.code }, { status: error.status })
  }
  return Response.json({ error: error instanceof Error ? error.message : "端点更新失败" }, { status: 500 })
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ endpointId: string }> }) {
  const auth = await resolveAuth()
  if (!auth.supabase || !auth.userId) return Response.json({ error: "请先登录" }, { status: 401 })
  const userId = auth.userId
  const gate = await enforceLimits(auth, req, { quota: false })
  if (gate.response) return gate.response
  const { endpointId } = await params
  if (!UUID.test(endpointId)) return Response.json({ error: "端点 ID 无效" }, { status: 400 })

  let body: Record<string, unknown>
  try { body = await readJson(req, { maxBytes: 16 * 1024 }) }
  catch (error) { return requestErrorResponse(error) }

  try {
    const current = await getOwnedModelEndpoint(auth.supabase, userId, endpointId)
    if (!current) return Response.json({ error: "端点不存在" }, { status: 404 })
    if (Object.prototype.hasOwnProperty.call(body, "baseUrl") && typeof body.baseUrl !== "string") {
      return Response.json({ error: "服务地址格式无效" }, { status: 400 })
    }
    let baseUrl = normalizeOpenAIBaseUrl(typeof body.baseUrl === "string" ? body.baseUrl : current.base_url)
    const apiKey = resolveEndpointPatchApiKey(
      body,
      current.base_url,
      baseUrl,
      () => resolveModelEndpointKey(current, userId),
    )
    const model = typeof body.model === "string" ? body.model.replace(/[\u0000-\u001f\u007f]/g, "").trim() : current.model
    if (body.outputKind !== undefined && !isModelOutputKind(body.outputKind)) {
      return Response.json({ error: "模型用途无效" }, { status: 400 })
    }
    if (!isModelOutputKind(current.output_kind)) {
      return Response.json({ error: "端点缺少有效用途，请重新连接" }, { status: 409 })
    }
    const outputKind = isModelOutputKind(body.outputKind) ? body.outputKind : current.output_kind
    if (outputKind !== "chat" && isKnownTextOnlyModel(model)) {
      return Response.json({ error: "当前模型是文本/对话模型，不能保存为图片或视频用途" }, { status: 400 })
    }
    if (body.authType !== undefined && (typeof body.authType !== "string" || !AUTH_TYPES.has(body.authType as EndpointAuthSelection))) {
      return Response.json({ error: "鉴权方式无效" }, { status: 400 })
    }
    const requestedAuthType: EndpointAuthSelection = body.authType === undefined
      ? endpointAuthType(current.auth_type)
      : body.authType as EndpointAuthSelection
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
    const update = {
      name: modelDisplayName(model, typeof body.displayName === "string" ? body.displayName : undefined, apiKey),
      base_url: baseUrl,
      api_key: sealModelEndpointKey(apiKey, {
        userId,
        endpointId,
        baseUrl,
        protocol: current.protocol,
        authType,
        model,
        outputKind,
      }),
      model,
      output_kind: outputKind,
      auth_type: authType,
      updated_at: new Date().toISOString(),
    }
    const { data, error } = await auth.supabase.from("endpoints").update(update)
      .eq("id", endpointId).eq("user_id", userId)
      .select("id,user_id,name,protocol,base_url,api_key,model,output_kind,auth_type,created_at,updated_at").single()
    if (error || !data) return Response.json({ error: "端点更新失败，请确认已执行最新 migration" }, { status: 503 })
    return Response.json({
      endpoint: endpointSummary(data as ModelEndpointRow),
      verification: { connectionVerified: true, generationVerified: outputKind === "chat" },
    })
  } catch (error) {
    return errorResponse(error)
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ endpointId: string }> }) {
  const auth = await resolveAuth()
  if (!auth.supabase || !auth.userId) return Response.json({ error: "请先登录" }, { status: 401 })
  const { endpointId } = await params
  if (!UUID.test(endpointId)) return Response.json({ error: "端点 ID 无效" }, { status: 400 })
  const { error } = await auth.supabase.from("endpoints").delete().eq("id", endpointId).eq("user_id", auth.userId)
  if (error) return Response.json({ error: "删除端点失败" }, { status: 500 })
  return Response.json({ ok: true })
}
