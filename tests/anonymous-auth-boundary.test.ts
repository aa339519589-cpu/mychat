import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('identity creation can only be performed through rate-limited server boundaries', async () => {
  const [login, anonymousRoute, emailRoute] = await Promise.all([
    readFile(new URL('../components/login-screen.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../app/api/auth/anonymous/route.ts', import.meta.url), 'utf8'),
    readFile(new URL('../app/api/auth/email/route.ts', import.meta.url), 'utf8'),
  ])

  assert.doesNotMatch(login, /\.auth\.signInAnonymously\s*\(/)
  assert.doesNotMatch(login, /\.auth\.(?:signUp|signInWithPassword)\s*\(/)
  assert.match(login, /fetch\(["']\/api\/auth\/anonymous["']/)
  assert.match(login, /fetch\(["']\/api\/auth\/email["']/)
  assert.match(anonymousRoute, /clientAddress\(req\)/)
  assert.match(anonymousRoute, /checkRateLimit\(`anonymous-signin:\$\{address\}`/)
  assert.match(anonymousRoute, /rate\.unavailable/)
  assert.match(anonymousRoute, /!rate\.allowed/)
  assert.match(anonymousRoute, /\.auth\.signInAnonymously\s*\(/)
  assert.match(emailRoute, /clientAddress\(request\)/)
  assert.match(emailRoute, /email-auth:\$\{input\.mode\}:ip:/)
  assert.match(emailRoute, /email-auth:\$\{input\.mode\}:identity:/)
  assert.match(emailRoute, /\.auth\.signUp\s*\(/)
  assert.match(emailRoute, /\.auth\.signInWithPassword\s*\(/)
})
