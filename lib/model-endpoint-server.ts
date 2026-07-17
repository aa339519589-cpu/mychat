import type { SupabaseClient } from "@/lib/supabase/types"
import {
  discoverOpenAIModels,
  ModelEndpointError,
  normalizeOpenAIBaseUrl,
} from "./llm/openai-compatible"
import { probeOpenAIChatDetailed } from "./llm/chat-endpoint-probe"
import { openModelEndpointKey, type ModelEndpointSecretContext } from "./model-endpoint-secret"
import { isKnownTextOnlyModel, isModelOutputKind, type EndpointAuthType, type ModelEndpointSummary, type ModelOutputKind } from "./model-endpoints"

export type ModelEndpointRow = {
  id: string
  user_id: string
  name: string
  protocol: string
  base_url: string
  api_key: string
  model: string
  output_kind?: string | null
  auth_type?: string | null
  created_at?: string | null
  updated_at?: string | null
}

const AUTH_TYPES = new Set<EndpointAuthType>(["bearer", "x-api-key", "api-key", "none"])

export function endpointAuthType(value: unknown): EndpointAuthType {
  return typeof value === "string" && AUTH_TYPES.has(value as EndpointAuthType)
    ? value as EndpointAuthType
    : "bearer"
}

export function endpointOutputKind(value: unknown): ModelOutputKind {
  return isModelOutputKind(value) ? value : "chat"
}

function endpointSecretContext(row: ModelEndpointRow, userId = row.user_id): ModelEndpointSecretContext {
  return {
    userId,
    endpointId: row.id,
    baseUrl: row.base_url,
    protocol: row.protocol,
    authType: typeof row.auth_type === "string" ? row.auth_type : "",
    model: row.model,
    outputKind: typeof row.output_kind === "string" ? row.output_kind : "",
  }
}

export function endpointSummary(row: ModelEndpointRow): ModelEndpointSummary {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    model: row.model,
    outputKind: endpointOutputKind(row.output_kind),
    authType: endpointAuthType(row.auth_type),
    needsReconnect: openModelEndpointKey(row.api_key, endpointSecretContext(row)) === null,
    ...(row.created_at ? { createdAt: row.created_at } : {}),
    ...(row.updated_at ? { updatedAt: row.updated_at } : {}),
  }
}

export async function getOwnedModelEndpoint(
  supabase: SupabaseClient,
  userId: string,
  endpointId: string,
): Promise<ModelEndpointRow | null> {
  const { data, error } = await supabase
    .from("endpoints")
    .select("id,user_id,name,protocol,base_url,api_key,model,output_kind,auth_type,created_at,updated_at")
    .eq("id", endpointId)
    .eq("user_id", userId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return data as ModelEndpointRow | null
}

export function resolveModelEndpointKey(row: ModelEndpointRow, userId: string): string {
  const outputKind = endpointOutputKind(row.output_kind)
  if (outputKind !== "chat" && isKnownTextOnlyModel(row.model)) {
    throw new Error("当前端点把文本/对话模型配置成了媒体模型，请在设置中重新选择 Seedream 或 Seedance")
  }
  const apiKey = openModelEndpointKey(row.api_key, endpointSecretContext(row, userId))
  if (apiKey === null) throw new Error("该端点使用旧版明文凭据或当前无法解密，请在设置中重新连接")
  return apiKey
}

export type EndpointAuthSelection = EndpointAuthType | "auto"

const OPTIONAL_MODEL_LIST_ERRORS = new Set([
  "models_not_found",
  "invalid_json",
  "invalid_shape",
  "empty_models",
])

export async function resolveMediaEndpointConnection(options: {
  baseUrl: string
  apiKey: string
  authType: EndpointAuthSelection
  signal?: AbortSignal
}): Promise<{ baseUrl: string; authType: EndpointAuthType }> {
  const baseUrl = normalizeOpenAIBaseUrl(options.baseUrl)
  try {
    const discovered = await discoverOpenAIModels({ ...options, baseUrl })
    return { baseUrl: discovered.baseUrl, authType: discovered.authType }
  } catch (error) {
    // Media generation has no side-effect-free compatibility probe. A reachable
    // but unsupported /models endpoint must not block a manually entered model.
    if (!(error instanceof ModelEndpointError) || !OPTIONAL_MODEL_LIST_ERRORS.has(error.code)) throw error
    return {
      baseUrl,
      authType: options.authType === "auto"
        ? options.apiKey.trim() ? "bearer" : "none"
        : options.authType,
    }
  }
}

export async function probeModelEndpointAuthentication(options: {
  baseUrl: string
  apiKey: string
  authType: EndpointAuthSelection
  model: string
  signal?: AbortSignal
}): Promise<EndpointAuthType> {
  const candidates: EndpointAuthType[] = options.authType === "auto"
    ? options.apiKey.trim() ? ["bearer", "x-api-key", "api-key", "none"] : ["none"]
    : [options.authType]

  for (let index = 0; index < candidates.length; index++) {
    const authType = candidates[index]
    try {
      await probeOpenAIChatDetailed({ ...options, authType })
      return authType
    } catch (error) {
      const canRetry = options.authType === "auto"
        && error instanceof ModelEndpointError
        && error.code === "auth_failed"
        && index < candidates.length - 1
      if (!canRetry) throw error
    }
  }

  throw new ModelEndpointError("API Key 被聊天接口拒绝", "chat", "auth_failed", 401)
}
