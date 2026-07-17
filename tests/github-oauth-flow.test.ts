import assert from 'node:assert/strict'
import test from 'node:test'
import {
  githubConnectionCookieMaxAge,
  parseGitHubOAuthCode,
  parseGitHubOAuthToken,
  parseGitHubUser,
  resolveGitHubOAuthBaseUrl,
} from '../lib/github-oauth-flow'

test('GitHub OAuth base URLs are canonical and reject redirect-bearing or insecure production values', () => {
  assert.equal(resolveGitHubOAuthBaseUrl(
    'https://app.example/base/',
    'https://ignored.example',
    true,
  ), 'https://app.example/base')
  assert.equal(resolveGitHubOAuthBaseUrl(undefined, 'http://localhost:3000', false), 'http://localhost:3000')

  for (const unsafe of [
    'http://app.example',
    'https://user:pass@app.example',
    'https://app.example/?next=https://evil.example',
    'https://app.example/#fragment',
    'javascript:alert(1)',
  ]) {
    assert.throws(() => resolveGitHubOAuthBaseUrl(unsafe, 'https://safe.example', true))
  }
})

test('GitHub OAuth codes, tokens, expiry, and scopes are bounded and fail closed', () => {
  assert.equal(parseGitHubOAuthCode('abc_DEF-123'), 'abc_DEF-123')
  assert.equal(parseGitHubOAuthCode('a'.repeat(1_025)), null)
  assert.equal(parseGitHubOAuthCode('bad.code'), null)

  const now = Date.parse('2026-07-17T00:00:00.000Z')
  const valid = parseGitHubOAuthToken({
    access_token: 'gho_valid-token',
    token_type: 'bearer',
    expires_in: '3600',
    scope: 'repo,read:user repo',
  }, now)
  assert.equal(valid.ok, true)
  if (valid.ok) {
    assert.deepEqual(valid.scopes, ['repo', 'read:user'])
    assert.equal(valid.expiresAt?.toISOString(), '2026-07-17T01:00:00.000Z')
  }

  const malformed = [
    { access_token: 'token\nheader', token_type: 'bearer' },
    { access_token: 'token', token_type: 'mac' },
    { access_token: 'token', expires_in: 40_000_000 },
    { access_token: 'token', scope: 'repo invalid/scope' },
    { access_token: 'x'.repeat(16_385) },
  ]
  for (const value of malformed) assert.equal(parseGitHubOAuthToken(value, now).ok, false)
  assert.equal(parseGitHubOAuthToken(malformed[0], now).accessToken, 'token\nheader')
})

test('GitHub OAuth user identity and browser cookie lifetime use strict provider bounds', () => {
  assert.deepEqual(parseGitHubUser({ login: 'octo-cat', id: 7 }), {
    login: 'octo-cat',
    githubUserId: 7,
  })
  for (const value of [
    { login: '-leading', id: 7 },
    { login: 'trailing-', id: 7 },
    { login: 'name_with_underscore', id: 7 },
    { login: 'octocat', id: 0 },
    { login: 'octocat', id: 1.5 },
  ]) assert.equal(parseGitHubUser(value), null)

  const now = Date.parse('2026-07-17T00:00:00.000Z')
  assert.equal(githubConnectionCookieMaxAge(null, now), 30 * 24 * 60 * 60)
  assert.equal(githubConnectionCookieMaxAge(new Date(now + 5_500), now), 5)
  assert.equal(githubConnectionCookieMaxAge(new Date(now - 1_000), now), 1)
})
