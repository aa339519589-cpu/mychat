import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

const PREFIX = 'mcp-connector:v1'

export type ConnectorSecretContext = {
  userId: string
  connectorId: string
  serverUrl: string
}

function currentSecret(): string {
  return process.env.AGENT_CREDENTIAL_KEY?.trim() ?? ''
}

function previousSecret(): string {
  return process.env.AGENT_CREDENTIAL_KEY_PREVIOUS?.trim() ?? ''
}

function key(secret: string): Buffer {
  return createHash('sha256').update(`mychat:${PREFIX}:${secret}`).digest()
}

function aad(context: ConnectorSecretContext): Buffer {
  return Buffer.from(JSON.stringify([
    PREFIX,
    context.userId,
    context.connectorId,
    context.serverUrl,
  ]), 'utf8')
}

export function connectorSecretEncryptionConfigured(): boolean {
  return currentSecret().length >= 32
}

export function sealConnectorSecret(value: string, context: ConnectorSecretContext): string {
  const secret = currentSecret()
  if (secret.length < 32) throw new Error('MCP 连接器凭据加密未配置')
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(secret), iv)
  cipher.setAAD(aad(context))
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return [PREFIX, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.')
}

export function openConnectorSecret(value: string, context: ConnectorSecretContext): string | null {
  if (!value.startsWith(`${PREFIX}.`)) return null
  const candidates = [...new Set([currentSecret(), previousSecret()])]
    .filter(secret => secret.length >= 32)
    .map(key)
  try {
    const [prefix, rawIv, rawTag, rawBody] = value.split('.')
    if (prefix !== PREFIX || !rawIv || !rawTag || rawBody === undefined) return null
    const iv = Buffer.from(rawIv, 'base64url')
    const tag = Buffer.from(rawTag, 'base64url')
    if (iv.length !== 12 || tag.length !== 16) return null
    for (const candidate of candidates) {
      try {
        const decipher = createDecipheriv('aes-256-gcm', candidate, iv)
        decipher.setAAD(aad(context))
        decipher.setAuthTag(tag)
        return Buffer.concat([
          decipher.update(Buffer.from(rawBody, 'base64url')),
          decipher.final(),
        ]).toString('utf8')
      } catch {
        // Try only the configured previous key to permit rotation.
      }
    }
    return null
  } catch {
    return null
  }
}
