/** GitHub credentials must never follow caller-controlled hosts or redirects. */
export function githubApiFetch(input: string, init: RequestInit = {}, timeoutMs = 30_000): Promise<Response> {
  const parsed = new URL(input)
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'api.github.com'
    || parsed.username || parsed.password || parsed.port || parsed.hash) {
    throw new Error('GitHub API URL is outside the permitted origin')
  }
  // Only path/query may come from callers; the destination stays fixed.
  const target = new URL('https://api.github.com')
  target.pathname = parsed.pathname
  target.search = parsed.search
  const signals = [init.signal, AbortSignal.timeout(timeoutMs)].filter(Boolean) as AbortSignal[]
  return fetch(target, { ...init, redirect: 'error', signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals) })
}
