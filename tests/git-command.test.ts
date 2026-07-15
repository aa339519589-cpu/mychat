import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { runGit } from '../lib/agent/git-publish/git-command'
import { isolatedGitEnvironment } from '../lib/agent/git-environment'

test('git subprocess environments exclude application credentials', () => {
  const environment = isolatedGitEnvironment({
    GIT_AUTHOR_NAME: 'agent',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.extraHeader',
    GIT_CONFIG_VALUE_0: 'Authorization: Basic test',
  }, {
    PATH: '/usr/bin',
    SUPABASE_SERVICE_ROLE_KEY: 'service-secret',
    DEEPSEEK_API_KEY: 'model-secret',
    E2B_API_KEY: 'sandbox-secret',
    GITHUB_CLIENT_SECRET: 'oauth-secret',
  })

  assert.equal(environment.PATH, '/usr/bin')
  assert.equal(environment.GIT_AUTHOR_NAME, 'agent')
  assert.equal(environment.GIT_CONFIG_VALUE_0, 'Authorization: Basic test')
  assert.equal(environment.GIT_CONFIG_NOSYSTEM, '1')
  assert.equal(environment.GIT_CONFIG_GLOBAL, '/dev/null')
  assert.equal(environment.SUPABASE_SERVICE_ROLE_KEY, undefined)
  assert.equal(environment.DEEPSEEK_API_KEY, undefined)
  assert.equal(environment.E2B_API_KEY, undefined)
  assert.equal(environment.GITHUB_CLIENT_SECRET, undefined)
})

test('git subprocesses are abortable without blocking worker timers', async t => {
  const root = mkdtempSync(join(tmpdir(), 'mychat-git-command-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const controller = new AbortController()
  let timerFired = false
  const startedAt = Date.now()
  const timer = setTimeout(() => {
    timerFired = true
    controller.abort(new Error('lease lost'))
  }, 50)
  t.after(() => clearTimeout(timer))

  await assert.rejects(runGit([
    '-c', 'alias.mychat-delay=!sleep 5', 'mychat-delay',
  ], {
    cwd: root,
    timeoutMs: 10_000,
    signal: controller.signal,
  }))

  assert.equal(timerFired, true)
  assert.ok(Date.now() - startedAt < 2_000)
})
