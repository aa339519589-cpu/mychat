import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
} from 'node:crypto'

const PREFIX = 'github-credential:v1'
const OAUTH_FALLBACK_SALT = Buffer.from(`mychat:${PREFIX}:oauth-fallback`, 'utf8')
const derivedFallbackKeys = new Map<string, Buffer>()

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

function previousSecret(): string {
  return process.env.AGENT_CREDENTIAL_KEY_PREVIOUS?.trim() ?? ''
}

function dedicatedKey(secret: string): Buffer {
  return createHash('sha256')
    .update(`mychat:${PREFIX}:${secret}`)
    .digest()
}

function oauthFallbackKey(secret = oauthFallbackSecret()): Buffer | null {
  if (secret.length < 32) return null
  const cached = derivedFallbackKeys.get(secret)
  if (cached) return cached

  // The OAuth client secret is high-entropy server key material, but the
  // compatibility path still uses a memory-hard KDF rather than a single hash.
  const derived = scryptSync(secret, OAUTH_FALLBACK_SALT, 32, {
    N: 16_384,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  })
  derivedFallbackKeys.set(secret, derived)
  return derived
}

function configuredKey(): Buffer {
  const dedicated = dedicatedSecret()
  if (dedicated.length >= 32) return dedicatedKey(dedicated)
  const fallback = oauthFallbackKey()
  if (!fallback) throw new Error('GitHub 凭据加密未配置')
  return fallback
}

function decryptionKeys(): Buffer[] {
  const candidates: Buffer[] = []
  const dedicated = dedicatedSecret()
  const previous = previousSecret()
  if (dedicated.length >= 32) candidates.push(dedicatedKey(dedicated))
  if (previous.length >= 32) candidates.push(dedicatedKey(previous))
  const fallback = oauthFallbackKey()
  if (fallback) candidates.push(fallback)

  return [...new Map(candidates.map(candidate => [candidate.toString('hex'), candidate])).values()]
}

function authenticatedData(context: GitHubCredentialContext): Buffer {
  return Buffer.from(JSON.stringify([PREFIX, context.userId, context.login]), 'utf8')
}

export function githubCredentialEncryptionConfigured(): boolean {
  return dedicatedSecret().length >= 32 || oauthFallbackSecret().length >= 32
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
  const cipher = createCipheriv('aes-256-gcm', configuredKey(), iv)
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
