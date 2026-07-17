import assert from 'node:assert/strict'
import test from 'node:test'
import {
  contentSecurityPolicy,
  createContentSecurityPolicyNonce,
} from '../lib/content-security-policy'

test('CSP uses unique nonces with only the required runtime eval exception', () => {
  const nonces = new Set(Array.from({ length: 32 }, () => createContentSecurityPolicyNonce()))
  assert.equal(nonces.size, 32)
  for (const nonce of nonces) {
    assert.match(nonce, /^[a-f0-9]{32}$/)
    const policy = contentSecurityPolicy(nonce)
    assert.match(policy, new RegExp(`script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`))
    assert.doesNotMatch(policy, /script-src[^;]*'unsafe-inline'/)
    assert.match(policy, /script-src[^;]*'unsafe-eval'/)
  }
})

test('CSP rejects malformed nonces and never permits inline scripts', () => {
  const policy = contentSecurityPolicy('a'.repeat(32))
  assert.doesNotMatch(policy, /script-src[^;]*'unsafe-inline'/)
  assert.throws(() => contentSecurityPolicy('not-a-nonce'), /Invalid content security policy nonce/)
})
