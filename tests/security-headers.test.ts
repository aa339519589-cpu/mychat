import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('the application emits a nonce-bound global browser security policy', async () => {
  const source = await readFile(new URL('../next.config.mjs', import.meta.url), 'utf8')
  const proxy = await readFile(new URL('../proxy.ts', import.meta.url), 'utf8')
  const policy = await readFile(new URL('../lib/content-security-policy.ts', import.meta.url), 'utf8')

  for (const directive of [
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    'upgrade-insecure-requests',
  ]) assert.ok(policy.includes(directive), directive)
  for (const header of [
    'Cross-Origin-Opener-Policy',
    'Cross-Origin-Resource-Policy',
    'Permissions-Policy',
    'Referrer-Policy',
    'Strict-Transport-Security',
    'X-Content-Type-Options',
    'X-Frame-Options',
  ]) assert.match(source, new RegExp(`key: '${header}'`))
  assert.match(source, /source: '\/:path\*'/)
  assert.match(proxy, /response\.headers\.set\("content-security-policy", policy\)/)
  assert.match(proxy, /requestHeaders\.set\("x-nonce", nonce\)/)
  assert.match(proxy, /requestHeaders\.set\("content-security-policy", policy\)/)
  assert.match(proxy, /response\.headers\.set\("cache-control", "private, no-store"\)/)
  assert.doesNotMatch(source, /Content-Security-Policy|unsafe-inline/)
  assert.doesNotMatch(policy, /script-src[^`\n]*unsafe-inline/)
})
