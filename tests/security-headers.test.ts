import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('the application emits a restrictive global browser security policy', async () => {
  const source = await readFile(new URL('../next.config.mjs', import.meta.url), 'utf8')
  for (const directive of [
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    'upgrade-insecure-requests',
  ]) assert.match(source, new RegExp(directive.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  for (const header of [
    'Content-Security-Policy',
    'Cross-Origin-Opener-Policy',
    'Cross-Origin-Resource-Policy',
    'Permissions-Policy',
    'Referrer-Policy',
    'Strict-Transport-Security',
    'X-Content-Type-Options',
    'X-Frame-Options',
  ]) assert.match(source, new RegExp(`key: '${header}'`))
  assert.match(source, /source: '\/:path\*'/)
  assert.doesNotMatch(
    source,
    /process\.env\.NODE_ENV === 'production' \? " 'unsafe-eval'"/,
  )
})
