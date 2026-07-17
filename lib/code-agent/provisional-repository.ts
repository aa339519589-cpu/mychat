const PROVISIONAL_OWNER = '__mychat_new__'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function provisionalRepositoryForSession(sessionId: string): string {
  if (!UUID_PATTERN.test(sessionId)) throw new TypeError('Invalid provisional Code session id')
  return `${PROVISIONAL_OWNER}/${sessionId.toLowerCase()}`
}

export function isProvisionalRepositoryForSession(repo: string, sessionId: string): boolean {
  try {
    return repo === provisionalRepositoryForSession(sessionId)
  } catch {
    return false
  }
}
