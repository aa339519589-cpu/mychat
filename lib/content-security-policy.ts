const CSP_NONCE = /^[a-f0-9]{32}$/

export function createContentSecurityPolicyNonce(): string {
  return crypto.randomUUID().replaceAll('-', '')
}

export function contentSecurityPolicy(nonce: string): string {
  if (!CSP_NONCE.test(nonce)) throw new TypeError('Invalid content security policy nonce')
  return [
    "default-src 'self'",
    // function-plot compiles user-entered math expressions with Function/eval.
    // Keep that exception explicit while nonce-binding every executable script.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'unsafe-eval'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "media-src 'self' blob: https:",
    "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://vitals.vercel-insights.com",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    'upgrade-insecure-requests',
  ].join('; ')
}
