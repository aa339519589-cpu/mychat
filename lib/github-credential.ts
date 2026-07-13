import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

const PREFIX = 'github-credential:v1'

export type GitHubCredentialContext = {
  userId: string
  login: string
}

function configuredSecret(): string {
  return process.env.AGENT_CREDENTIAL_KEY?.trim() ?? ''
}

function key(): Buffer {
  return createHash('sha256')
    .update(`mychat:${PREFIX}:${configuredSecret()}`)
    .digest()
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
    const decipher = createDecipheriv('aes-256-gcm', key(), iv)
    decipher.setAAD(authenticatedData(context))
    decipher.setAuthTag(tag)
    return Buffer.concat([
      decipher.update(Buffer.from(rawBody, 'base64url')),
      decipher.final(),
    ]).toString('utf8')
  } catch {
    return null
  }
}
