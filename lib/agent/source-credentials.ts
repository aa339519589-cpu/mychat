/** Source references and explicitly named placeholders are not credential values.
 * Log redaction deliberately remains stricter and is a separate policy. */
const SOURCE_SECRET_PATTERNS = [
  /\b(?:sk-(?:proj-|ant-api\d+-)?[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{35}|gh[po]_[A-Za-z0-9]{36})\b/g,
  /-----BEGIN(?: RSA| EC| DSA| OPENSSH)? PRIVATE KEY-----\s*[A-Za-z0-9+/=\s]{64,}-----END[^\n]*PRIVATE KEY-----/g,
  /Authorization\s*[:=]\s*Bearer\s+([^\s"'`\\]+)/gi,
  /\b(?:password|secret|token)\s*[:=]\s*["']([^"'\r\n]{4,})["']/gi,
  /\b(?:DATABASE_URL|NEXT_PUBLIC_SUPABASE_ANON_KEY)[ \t]*=[ \t]*([^\s]+)/g,
]

const INERT_EXACT_SAMPLES = new Set([
  'test-token', 'test-secret', 'synthetic-github-token', 'hidden', 'server-only',
  'internal-v4-task-token', 'ci-public-anon-key', 'test-connector-token',
  'ghp_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ',
  'test-github-oauth-client-secret-with-at-least-32-characters',
  'test-dedicated-agent-credential-key-with-at-least-32-characters',
  'test-github-credential-secret-with-at-least-32-characters',
  'synthetic-github-oauth-token-that-must-never-reach-a-cookie-or-database',
  'github-client-secret', 'sk-abcdefghijklmnopqrstuvwxyz123456',
  'sk-test-secret-value-1234567890', 'secret',
])

export function containsSourceCredential(text: string): boolean {
  // Remove only expression references, preserving literal surroundings for the scan.
  const referencesRemoved = text.replace(/\$\{\{[^}]*\}\}|\$\{[^}]*\}|process\.env\.[A-Z_][A-Z0-9_]*/g, '<reference>')
  for (const pattern of SOURCE_SECRET_PATTERNS) {
    pattern.lastIndex = 0
    for (const match of referencesRemoved.matchAll(pattern)) {
      const value = (match[1] ?? match[0]).trim()
      if (value === '<reference>' || /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(value)
        || INERT_EXACT_SAMPLES.has(value)) continue
      return true
    }
  }
  return false
}
