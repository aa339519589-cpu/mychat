import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

const PREFIX = 'github-credential:v1'

export type GitHubCredentialContext = {
  userId: string
  login: string
}

function dedicatedSecret(): string {
  return process.env.AGENT_CREDENTIAL_KEY?.trim() ?? ''
}

function oauthFallbackSecret(): string {
  return process.env.GITHUB_CLIENT_SECRET?.trim() ?? ''
}

function configuredSecret(): string {
  const dedicated = dedicatedSecret()
  // GitHub OAuth already requires a server-only client secret. Reuse it only as
  // an availability fallback when the newer dedicated credential key has not
  // yet been provisioned on an existing production service.
  return dedicated.length >= 32 ? dedicated : oauthFallbackSecret()
}

function previousSecret(): string {
  return process.env.AGENT_CREDENTIAL_KEY_PREVIOUS?.trim() ?? ''
}

function key(secret = configuredSecret()): Buffer {
  return createHash('sha256')
    .update(`mychat:${PREFIX}:${secret}`)
    .digest()
}

function decryptionKeys(): Buffer[] {
  // Keep the OAuth fallback in the read set after a dedicated key is added so
  // connections created during the compatibility window remain decryptable.
  return [...new Set([configuredSecret(), previousSecret(), oauthFallbackSecret()])]
    .filter(secret => secret.length >= 32)
    .map(secret => key(secret))
}

function authenticatedData(context: GitHubCredentialContext): Buffer {
  return Buffer.from(JSON.stringify([PREFIX, context.userId, context.login]), 'utf8')
}

export function githubCredentialEncryptionConfigured(): boolean {
  return configuredSecret().length >= 32
}

export function sealGitHubCredential(
  token: string,
  context: GitHubCredentialContext,
): string {
  if (!githubCredentialEncryptionConfigured()) {
    throw new Error('GitHub 凭据加密未配置')
  }
  if (!token || !context.userId || !context.login) {
    throw new Error('GitHub 凭据上下文无效')
  }
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(), iv)
  cipher.setAAD(authenticatedData(context))
  const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()])
  return [
    PREFIX,
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    encrypted.toString('base64url'),
  ].join('.')
}

export function openGitHubCredential(
  value: string,
  context: GitHubCredentialContext,
): string | null {
  if (!githubCredentialEncryptionConfigured() || !value.startsWith(`${PREFIX}.`)) return null
  try {
    const [prefix, rawIv, rawTag, rawBody] = value.split('.')
    if (prefix !== PREFIX || !rawIv || !rawTag || rawBody === undefined) return null
    const iv = Buffer.from(rawIv, 'base64url')
    const tag = Buffer.from(rawTag, 'base64url')
    if (iv.length !== 12 || tag.length !== 16) return null
    for (const candidate of decryptionKeys()) {
      try {
        const decipher = createDecipheriv('aes-256-gcm', candidate, iv)
        decipher.setAAD(authenticatedData(context))
        decipher.setAuthTag(tag)
        return Buffer.concat([
          decipher.update(Buffer.from(rawBody, 'base64url')),
          decipher.final(),
        ]).toString('utf8')
      } catch {
        // Continue only across explicitly configured rotation or compatibility keys.
      }
    }
    return null
  } catch {
    return null
  }
}
