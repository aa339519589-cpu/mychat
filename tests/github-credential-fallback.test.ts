import assert from 'node:assert/strict'
import test from 'node:test'
import { openGitHubCredential, sealGitHubCredential } from '../lib/github-credential'

const USER_ID = '11111111-1111-4111-8111-111111111111'
const LOGIN = 'octocat'
const TOKEN = 'synthetic-github-token'
const OAUTH_SECRET = 'test-github-oauth-client-secret-with-at-least-32-characters'
const DEDICATED_SECRET = 'test-dedicated-agent-credential-key-with-at-least-32-characters'

function restoreEnvironment(
  dedicated: string | undefined,
  oauth: string | undefined,
): void {
  if (dedicated === undefined) delete process.env.AGENT_CREDENTIAL_KEY
  else process.env.AGENT_CREDENTIAL_KEY = dedicated
  if (oauth === undefined) delete process.env.GITHUB_CLIENT_SECRET
  else process.env.GITHUB_CLIENT_SECRET = oauth
}

test('GitHub OAuth client secret safely restores credential encryption when the dedicated key is absent', { concurrency: false }, t => {
  const dedicated = process.env.AGENT_CREDENTIAL_KEY
  const oauth = process.env.GITHUB_CLIENT_SECRET
  delete process.env.AGENT_CREDENTIAL_KEY
  process.env.GITHUB_CLIENT_SECRET = OAUTH_SECRET
  t.after(() => restoreEnvironment(dedicated, oauth))

  const context = { userId: USER_ID, login: LOGIN }
  const ciphertext = sealGitHubCredential(TOKEN, context)
  assert.match(ciphertext, /^github-credential:v1\./)
  assert.equal(openGitHubCredential(ciphertext, context), TOKEN)
})

test('credentials created with the OAuth fallback remain readable after a dedicated key is provisioned', { concurrency: false }, t => {
  const dedicated = process.env.AGENT_CREDENTIAL_KEY
  const oauth = process.env.GITHUB_CLIENT_SECRET
  delete process.env.AGENT_CREDENTIAL_KEY
  process.env.GITHUB_CLIENT_SECRET = OAUTH_SECRET
  t.after(() => restoreEnvironment(dedicated, oauth))

  const context = { userId: USER_ID, login: LOGIN }
  const ciphertext = sealGitHubCredential(TOKEN, context)
  process.env.AGENT_CREDENTIAL_KEY = DEDICATED_SECRET

  assert.equal(openGitHubCredential(ciphertext, context), TOKEN)
})
