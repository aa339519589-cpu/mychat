import { ModelEndpointError, normalizeOpenAIBaseUrl } from "./llm/openai-compatible"
import {
  endpointAuthType,
  resolveModelEndpointKey,
  type EndpointAuthSelection,
  type ModelEndpointRow,
} from "./model-endpoint-server"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const AUTH_TYPES = new Set<EndpointAuthSelection>(["auto", "bearer", "x-api-key", "api-key", "none"])
const STORED_FIELDS = new Set(["sourceEndpointId", "model", "outputKind", "displayName"])

/** Add a model on an owned connection without returning or redirecting its key. */
export async function resolveEndpointCreationConnection(
  body: Record<string, unknown>,
  userId: string,
  loadOwned: (id: string) => Promise<ModelEndpointRow | null>,
): Promise<{ baseUrl: string; apiKey: string; authType: EndpointAuthSelection }> {
  if (Object.prototype.hasOwnProperty.call(body, "sourceEndpointId")) {
    if (Object.keys(body).some(field => !STORED_FIELDS.has(field))) {
      throw new ModelEndpointError("复用已保存连接时不能覆盖地址、凭据或鉴权方式", "url", "stored_endpoint_override", 400)
    }
    if (typeof body.sourceEndpointId !== "string" || !UUID.test(body.sourceEndpointId)) {
      throw new ModelEndpointError("端点 ID 无效", "url", "invalid_endpoint_id", 400)
    }
    const source = await loadOwned(body.sourceEndpointId)
    if (!source || source.user_id !== userId || source.id !== body.sourceEndpointId) {
      throw new ModelEndpointError("端点不存在", "url", "endpoint_not_found", 404)
    }
    if (source.output_kind !== body.outputKind) {
      throw new ModelEndpointError("复用连接必须保持相同模型用途", "url", "endpoint_output_mismatch", 400)
    }
    return {
      baseUrl: normalizeOpenAIBaseUrl(source.base_url),
      apiKey: resolveModelEndpointKey(source, userId),
      authType: endpointAuthType(source.auth_type),
    }
  }
  if (body.authType !== undefined && (typeof body.authType !== "string" || !AUTH_TYPES.has(body.authType as EndpointAuthSelection))) {
    throw new ModelEndpointError("鉴权方式无效", "url", "invalid_auth_type", 400)
  }
  return {
    baseUrl: normalizeOpenAIBaseUrl(typeof body.baseUrl === "string" ? body.baseUrl : ""),
    apiKey: typeof body.apiKey === "string" ? body.apiKey.trim() : "",
    authType: (body.authType ?? "auto") as EndpointAuthSelection,
  }
}
