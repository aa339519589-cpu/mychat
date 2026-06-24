import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "crypto"

export type RecoveryTokenPayload = {
  taskId: string
  cookie: string
  expiresAt: number
}

function secret(): string {
  return process.env.AGENT_CREDENTIAL_KEY?.trim() ?? ""
}

function key(): Buffer {
  return createHash("sha256").update(secret()).digest()
}

export function recoveryConfigured(): boolean {
  return secret().length >= 32
}

export function sealRecoveryToken(payload: RecoveryTokenPayload): string | null {
  if (!recoveryConfigured()) return null
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key(), iv)
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()])
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".")
}

export function openRecoveryToken(token: string): RecoveryTokenPayload | null {
  if (!recoveryConfigured()) return null
  try {
    const [version, ivRaw, tagRaw, bodyRaw] = token.split(".")
    if (version !== "v1" || !ivRaw || !tagRaw || !bodyRaw) return null
    const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(ivRaw, "base64url"))
    decipher.setAuthTag(Buffer.from(tagRaw, "base64url"))
    const plain = Buffer.concat([decipher.update(Buffer.from(bodyRaw, "base64url")), decipher.final()])
    const payload = JSON.parse(plain.toString("utf8")) as RecoveryTokenPayload
    if (!payload.taskId || !payload.cookie || payload.expiresAt <= Date.now()) return null
    return payload
  } catch {
    return null
  }
}

export function internalRecoveryToken(): string {
  return createHash("sha256").update(`mychat-agent-recovery:${secret()}`).digest("hex")
}

export function isInternalRecoveryToken(value: string | null): boolean {
  if (!recoveryConfigured() || !value) return false
  const expected = Buffer.from(internalRecoveryToken())
  const actual = Buffer.from(value)
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}
