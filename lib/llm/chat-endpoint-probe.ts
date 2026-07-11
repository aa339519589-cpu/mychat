import { isSafeModelId, type EndpointAuthType } from "@/lib/model-endpoints"
import { chatCompletionsUrl } from "./openai"
import {
  endpointAuthHeaders,
  ModelEndpointError,
  normalizeOpenAIBaseUrl,
  safeModelEndpointFetch,
} from "./openai-compatible"

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const PROBE_TIMEOUT_MS = 60_000

function redact(value: string, secrets: string[]): string {
  let safe = value
  for (const secret of secrets.map(item => item.trim()).filter(Boolean)) {
    safe = safe.split(secret).join("***")
  }
  return safe
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "***")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .slice(0, 240)
}

function upstreamDetail(raw: string, secrets: string[]): string {
  try {
    const payload = JSON.parse(raw)
    const message = payload?.error?.message ?? payload?.message ?? payload?.detail
      ?? payload?.error?.code ?? payload?.code
    return typeof message === "string" ? redact(message, secrets) : ""
  } catch {
    return redact(raw, secrets)
  }
}

async function readLimitedText(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined)
    throw new ModelEndpointError("聊天接口响应过大", "chat", "response_too_large", 502)
  }
  if (!response.body) return ""

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let bytes = 0
  let text = ""
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new ModelEndpointError("聊天接口响应过大", "chat", "response_too_large", 502)
      }
      text += decoder.decode(value, { stream: true })
    }
    return text + decoder.decode()
  } finally {
    reader.releaseLock()
  }
}

export async function probeOpenAIChatDetailed(options: {
  baseUrl: string
  apiKey?: string
  authType: EndpointAuthType
  model: string
  signal?: AbortSignal
}): Promise<{ content: string }> {
  const baseUrl = normalizeOpenAIBaseUrl(options.baseUrl)
  const model = options.model.replace(/[\u0000-\u001f\u007f]/g, "").trim()
  if (!isSafeModelId(model) || model.length > 512) {
    throw new ModelEndpointError("模型 ID 无效，不能填写 URL 或 API Key", "chat", "invalid_model")
  }

  let response: Response
  try {
    const signals = [options.signal, AbortSignal.timeout(PROBE_TIMEOUT_MS)].filter(Boolean) as AbortSignal[]
    response = await safeModelEndpointFetch(chatCompletionsUrl(baseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream, application/json",
        ...endpointAuthHeaders(options.apiKey ?? "", options.authType),
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "Reply with exactly OK" }],
        stream: true,
      }),
      redirect: "manual",
      signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals),
    })
  } catch (error) {
    if (options.signal?.aborted) throw error
    if (error instanceof ModelEndpointError) throw error
    throw new ModelEndpointError(
      error instanceof Error && error.name === "TimeoutError" ? "模型生成测试超时" : "无法连接聊天接口",
      "chat",
      "connect_failed",
      502,
    )
  }

  const raw = await readLimitedText(response)
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new ModelEndpointError("API Key 被聊天接口拒绝", "chat", "auth_failed", response.status)
    }
    const detail = upstreamDetail(raw, [options.apiKey ?? ""])
    if (response.status === 404 || response.status === 405) {
      throw new ModelEndpointError(
        `聊天请求返回 ${response.status}${detail ? `：${detail}` : "；请检查 Base URL 和模型 ID"}`,
        "chat",
        "chat_not_found",
        response.status,
      )
    }
    throw new ModelEndpointError(
      `模型生成测试失败（${response.status}）${detail ? `：${detail}` : ""}`,
      "chat",
      "upstream_error",
      response.status,
    )
  }

  let content = ""
  if (response.headers.get("content-type")?.includes("application/json")) {
    try { content = String(JSON.parse(raw)?.choices?.[0]?.message?.content ?? "") } catch { /* handled below */ }
  } else {
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed.startsWith("data:") || trimmed === "data: [DONE]") continue
      try {
        const event = JSON.parse(trimmed.slice(5).trim())
        content += String(event?.choices?.[0]?.delta?.content ?? event?.choices?.[0]?.message?.content ?? "")
      } catch { /* ignore keepalive or malformed optional chunks */ }
    }
  }
  if (!content.trim()) {
    throw new ModelEndpointError("聊天接口已响应，但没有生成文本；所选模型可能不是对话模型", "chat", "empty_response", 422)
  }
  return { content: content.trim().slice(0, 200) }
}
