export type EndpointAuthType = "bearer" | "x-api-key" | "api-key" | "none"

export type DiscoveredModel = {
  id: string
  displayName: string
  ownedBy?: string
  chatCompatible: boolean
}

export type ModelEndpointSummary = {
  id: string
  name: string
  baseUrl: string
  model: string
  outputKind: ModelOutputKind
  authType: EndpointAuthType
  needsReconnect: boolean
  createdAt?: string
  updatedAt?: string
}

export type ModelOutputKind = "chat" | "image" | "video"

const MODEL_TOKEN_START = "(?:^|[-_.\\/:])"
const MODEL_TOKEN_END = "(?=$|[-_.\\/:]|\\d)"
const IMAGE_MODEL = new RegExp(
  `${MODEL_TOKEN_START}(?:image|images|imagen|dall[-_.]?e|gpt[-_.]?image|flux|stable[-_.]?diffusion|sdxl)${MODEL_TOKEN_END}`,
  "i",
)
const VIDEO_MODEL = new RegExp(
  `${MODEL_TOKEN_START}(?:video|sora|veo|kling|wan)${MODEL_TOKEN_END}`,
  "i",
)
const NON_CHAT_MODEL = /(?:^|[-_.\/])(embedding|embed|rerank|moderation|whisper|transcri|speech|tts)(?:$|[-_.\/])/i

/** Classify the primary output expected from a model ID. Unknown IDs are chat. */
export function modelOutputKind(modelId: string): ModelOutputKind {
  const normalized = modelId.trim()
  // Image-to-video model names commonly contain both tokens; the final output
  // is video, so video deliberately takes precedence.
  if (VIDEO_MODEL.test(normalized)) return "video"
  if (IMAGE_MODEL.test(normalized)) return "image"
  return "chat"
}

export function isModelOutputKind(value: unknown): value is ModelOutputKind {
  return value === "chat" || value === "image" || value === "video"
}

export function isLikelyChatModel(modelId: string): boolean {
  const normalized = modelId.trim()
  return modelOutputKind(normalized) === "chat" && !NON_CHAT_MODEL.test(normalized)
}

export function isSafeModelId(value: string, apiKey?: string): boolean {
  const modelId = value.trim()
  const exactCredential = apiKey?.trim()
  return modelId.length > 0
    && modelId.length <= 512
    && !/[\u0000-\u001f\u007f]/.test(modelId)
    && !/^sk-[A-Za-z0-9_-]{8,}$/i.test(modelId)
    && !/^https?:\/\//i.test(modelId)
    && (!exactCredential || modelId !== exactCredential)
}

export function modelDisplayName(modelId: string, provided?: string, apiKey?: string): string {
  const display = provided?.replace(/[\u0000-\u001f\u007f]/g, "").trim()
  const exactCredential = apiKey?.trim()
  const safeDisplay = display
    && display !== exactCredential
    && !/^sk-[A-Za-z0-9_-]{8,}$/i.test(display)
    && !/^https?:\/\//i.test(display)
    ? display
    : ""
  return (safeDisplay || modelId.trim()).slice(0, 160)
}
