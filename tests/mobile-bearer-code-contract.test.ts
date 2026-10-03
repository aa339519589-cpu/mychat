import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8')
}

test('Code and GitHub routes bind mobile bearer authentication to the incoming request', () => {
  const codeChat = source('app/api/code/chat/route.ts')
  const codeApply = source('app/api/code/apply/route.ts')
  const githubStatus = source('app/api/github/status/route.ts')
  const githubRepos = source('app/api/github/repos/route.ts')

  assert.match(codeChat, /resolveAuth\(request\)/)
  assert.match(codeChat, /getCurrentGitHubConnectionStatus\(\{[\s\S]*?request[,\s]/)
  assert.match(codeApply, /resolveAuth\(request\)/)
  assert.match(codeApply, /getCurrentGitHubConnectionStatus\(\{[\s\S]*?request[,\s]/)
  assert.match(githubStatus, /getCurrentGitHubConnectionStatus\(\{[\s\S]*?request: req/)
  assert.match(githubRepos, /getGitHubSession\(\{[\s\S]*?request: req/)
})

test('memory preference route supports verified mobile bearer tokens without widening profile grants', () => {
  const memoryRoute = source('app/api/profile/memory/route.ts')

  assert.equal((memoryRoute.match(/resolveAuth\(request\)/g) ?? []).length, 1)
  assert.match(memoryRoute, /authenticatedUserId\(request\)/)
  assert.match(memoryRoute, /\.upsert\(\{ user_id: userId, memory_enabled: enabled \}/)
  assert.match(memoryRoute, /\.eq\('user_id', auth\.userId\)/)
  assert.doesNotMatch(memoryRoute, /GRANT\s+(?:INSERT|UPDATE|ALL)\s+ON\s+(?:TABLE\s+)?public\.profiles/i)
})

test('browser memory preferences use the same authenticated API instead of revoked profile writes', () => {
  const profile = source('lib/data/profile.ts')

  assert.match(profile, /memorySettingResponse\("GET"\)/)
  assert.match(profile, /memorySettingResponse\("PUT", enabled\)/)
  assert.match(profile, /export async function setMemoryEnabled\(_userId: string, enabled: boolean\): Promise<void> \{\s*await memorySettingResponse\("PUT", enabled\)\s*\}/)
})

test('global memory rows use the authenticated server API instead of direct table permissions', () => {
  const memoryRoute = source('lib/api/memory-management.ts')
  const browserMemory = source('lib/data/memory.ts')

  assert.match(memoryRoute, /resolveAuth\(request\)/)
  assert.match(memoryRoute, /\.eq\('user_id', userId\)/)
  assert.match(memoryRoute, /\.eq\('id', id\)\s*\.eq\('user_id', userId\)/)
  assert.match(browserMemory, /fetch\(path,[\s\S]*credentials: 'same-origin'/)
  assert.match(browserMemory, /['"]\/api\/memories['"]/)
  assert.doesNotMatch(browserMemory, /createClient|\.from\(["'`]memories/)
})

test('GitHub session keeps cookie-bound browser access and uses server-audited access only for bearer requests', () => {
  const session = source('lib/github-session.ts')

  assert.match(session, /resolveAuth\(options\.request\)/)
  assert.match(session, /hasBearerAuthorization\(options\.request\)/)
  assert.match(session, /bearerAuthenticated \? "service" : "user"/)
  assert.match(session, /mobile-api:\$\{userId\}/)
  assert.match(session, /if \(!bearerAuthenticated && !connectionId\) return null/)
  assert.doesNotMatch(session, /Authorization[^\n]*cookie/i)
})

test('native GitHub OAuth authenticates its start request and returns only a fixed app callback', () => {
  const start = source('app/api/mobile/github/oauth/start/route.ts')
  const callback = source('app/api/auth/github/callback/route.ts')

  assert.match(start, /resolveAuth\(request\)/)
  assert.match(start, /createGitHubMobileOAuthState\(auth\.userId, clientSecret\)/)
  assert.match(start, /authorizationUrl: `https:\/\/github\.com\/login\/oauth\/authorize/)
  assert.match(start, /callbackScheme: 'mychat'/)
  assert.match(callback, /verifyGitHubMobileOAuthState\(state, config\.clientSecret\)/)
  assert.match(callback, /Location: `mychat:\/\/oauth\/github\?status=\$\{outcome\}`/)
  assert.doesNotMatch(callback, /mychat:\/\/[^\n]*(?:token|connection)/i)
})
