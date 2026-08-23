import { createHash } from 'node:crypto'

function digest(value: string, length = 24): string {
  return createHash('sha256').update(value).digest('hex').slice(0, length)
}

export function chatGptBridgeQueue(principalId: string): string {
  return `chatgpt-web-${digest(principalId)}`
}

export function chatGptBridgeWorkerId(principalId: string, clientId: string): string {
  return `chatgpt-web:${digest(`${principalId}:${clientId}`, 32)}`
}

export function bearerToken(request: Request): string {
  const value = request.headers.get('authorization')?.trim() ?? ''
  return value.toLowerCase().startsWith('bearer ') ? value.slice(7).trim() : ''
}
