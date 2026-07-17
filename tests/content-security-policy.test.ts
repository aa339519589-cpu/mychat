import assert from 'node:assert/strict'
import test from 'node:test'
import {
  contentSecurityPolicy,
  createContentSecurityPolicyNonce,
} from '../lib/content-security-policy'

test('production CSP uses unique nonces without inline script permission', () => {
  const nonces = new Set(Array.from({ length: 32 }, () => createContentSecurityPolicyNonce()))
  assert.equal(nonces.size, 32)
  for (const nonce of nonces) {
    assert.match(nonce, /^[a-f0-9]{32}$/)
    const policy = contentSecurityPolicy(nonce, true)
    assert.match(policy, new RegExp(`script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`))
    assert.doesNotMatch(policy, /script-src[^;]*'unsafe-inline'/)
    assert.doesNotMatch(policy, /script-src[^;]*'unsafe-eval'/)
  }
})

test('development CSP permits eval only for framework debugging', () => {
  const policy = contentSecurityPolicy('a'.repeat(32), false)
  assert.match(policy, /script-src[^;]*'unsafe-eval'/)
  assert.doesNotMatch(policy, /script-src[^;]*'unsafe-inline'/)
  assert.throws(() => contentSecurityPolicy('not-a-nonce', true), /Invalid content security policy nonce/)
})
