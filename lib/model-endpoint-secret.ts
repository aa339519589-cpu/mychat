import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto"
import { normalizeOpenAIBaseUrl } from "./llm/openai-compatible"

const PREFIX = "model-endpoint:v3"
const COMPAT_BASE_URL = "https://legacy-signature.invalid"

export type ModelEndpointSecretContext = {
  userId: string
  endpointId: string
  baseUrl: string
  protocol: string
  authType: string
  model: string
  outputKind: string
}

function configuredSecret(): string {
  return process.env.AGENT_CREDENTIAL_KEY?.trim() ?? ""
}

function previousSecret(): string {
  return process.env.AGENT_CREDENTIAL_KEY_PREVIOUS?.trim() ?? ""
}

function encryptionKey(secret = configuredSecret()): Buffer {
  return createHash("sha256").update(`mychat:model-endpoint:v3:${secret}`).digest()
}

function decryptionKeys(): Buffer[] {
  return [...new Set([configuredSecret(), previousSecret()])]
    .filter(secret => secret.length >= 32)
    .map(secret => encryptionKey(secret))
}

function legacySignatureContext(userId: string, endpointId: string): ModelEndpointSecretContext {
  return {
    userId,
    endpointId,
    baseUrl: COMPAT_BASE_URL,
    protocol: "openai",
    authType: "none",
    model: "legacy-signature",
    outputKind: "chat",
  }
}

// Kept for existing unit-level callers only. Its sentinel routing fields mean
// the result cannot decrypt as a real endpoint row; production callers must
// provide the complete context overload.
function resolveContext(
  contextOrUserId: ModelEndpointSecretContext | string,
  endpointId?: string,
): ModelEndpointSecretContext | null {
  if (typeof contextOrUserId !== "string") return contextOrUserId
  if (!endpointId) return null
  return legacySignatureContext(contextOrUserId, endpointId)
}

function canonicalBaseUrl(baseUrl: string): string | null {
  try { return normalizeOpenAIBaseUrl(baseUrl) } catch { return null }
}

function aad(context: ModelEndpointSecretContext): Buffer | null {
  const baseUrl = canonicalBaseUrl(context.baseUrl)
  if (!baseUrl || baseUrl !== context.baseUrl) return null
  return Buffer.from(JSON.stringify([
    PREFIX,
    context.userId,
    context.endpointId,
    baseUrl,
    context.protocol,
    context.authType,
    context.model,
    context.outputKind,
  ]), "utf8")
}

export function modelEndpointEncryptionConfigured(): boolean {
  return configuredSecret().length >= 32
}

export function isEncryptedModelEndpointKey(value: string): boolean {
  return value.startsWith(`${PREFIX}.`)
}

export function sealModelEndpointKey(apiKey: string, context: ModelEndpointSecretContext): string
/** @deprecated Pass the complete endpoint context so every routing field is authenticated. */
export function sealModelEndpointKey(apiKey: string, userId: string, endpointId: string): string
export function sealModelEndpointKey(
  apiKey: string,
  contextOrUserId: ModelEndpointSecretContext | string,
  endpointId?: string,
): string {
  if (!modelEndpointEncryptionConfigured()) {
    throw new Error("模型端点凭据加密未配置，请设置至少 32 字符的 AGENT_CREDENTIAL_KEY")
  }
  const context = resolveContext(contextOrUserId, endpointId)
  const authenticatedData = context ? aad(context) : null
  if (!authenticatedData) throw new Error("模型端点配置无效，无法加密凭据")

  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv)
  cipher.setAAD(authenticatedData)
  const encrypted = Buffer.concat([cipher.update(apiKey, "utf8"), cipher.final()])
  return [PREFIX, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".")
}

export function openModelEndpointKey(value: string, context: ModelEndpointSecretContext): string | null
/** @deprecated Pass the complete endpoint context so every routing field is authenticated. */
export function openModelEndpointKey(value: string, userId: string, endpointId: string): string | null
export function openModelEndpointKey(
  value: string,
  contextOrUserId: ModelEndpointSecretContext | string,
  endpointId?: string,
): string | null {
  if (!modelEndpointEncryptionConfigured() || !isEncryptedModelEndpointKey(value)) return null
  const context = resolveContext(contextOrUserId, endpointId)
  const authenticatedData = context ? aad(context) : null
  if (!authenticatedData) return null

  try {
    const parts = value.split(".")
    if (parts.length !== 4) return null
    const [prefix, ivRaw, tagRaw, bodyRaw] = parts
    if (prefix !== PREFIX || !ivRaw || !tagRaw || bodyRaw === undefined) return null
    const iv = Buffer.from(ivRaw, "base64url")
    const tag = Buffer.from(tagRaw, "base64url")
    if (iv.length !== 12 || tag.length !== 16) return null

    for (const candidate of decryptionKeys()) {
      try {
        const decipher = createDecipheriv("aes-256-gcm", candidate, iv)
        decipher.setAAD(authenticatedData)
        decipher.setAuthTag(tag)
        return Buffer.concat([
          decipher.update(Buffer.from(bodyRaw, "base64url")),
          decipher.final(),
        ]).toString("utf8")
      } catch {
        // Continue only across explicitly configured rotation keys.
      }
    }
    return null
  } catch {
    return null
  }
}
