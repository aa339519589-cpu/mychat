import test from 'node:test'
import assert from 'node:assert/strict'
import { containsSourceCredential } from '../lib/agent/source-credentials'
import { redactSensitive } from '../lib/agent/path-security'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { workspaceRoot } from '../lib/agent/workspace'
import { collectIsolatedWorkspaceFiles } from '../lib/agent/isolated-files'

test('source credentials preserve expression references and only exact reviewed inert samples', () => {
  for (const source of ['Authorization: Bearer $RENDER_API_KEY', 'token: "${process.env.GITHUB_TOKEN}"',
    'token: "${{ secrets.GITHUB_TOKEN }}"', 'token: "synthetic-github-token"', 'secret: "server-only"',
    'secret: "hidden"', 'NEXT_PUBLIC_SUPABASE_' + 'ANON_KEY=\nOTHER_CONFIG=value',
    '-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----']) {
    assert.equal(containsSourceCredential(source), false)
  }
  assert.notEqual(redactSensitive('Authorization: Bearer $RENDER_API_KEY'), 'Authorization: Bearer $RENDER_API_KEY')
})

test('complete tracked repository source passes real bounded upload collection without truncation', t => {
  const userId = `source-probe-${crypto.randomUUID()}`, taskId = `source-probe-${crypto.randomUUID()}`
  const root = workspaceRoot(taskId, userId)
  mkdirSync(root, { recursive: true })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const paths = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { encoding: 'utf8' }).split('\0').filter(path => path.length > 0 && existsSync(path))
  for (const path of paths) {
    const target = join(root, path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, readFileSync(path))
  }
  const collected = collectIsolatedWorkspaceFiles(userId, taskId)
  const actualPaths = new Set(collected.map(file => file.relativePath))
  t.diagnostic(JSON.stringify({ omittedPaths: paths.filter(path => !actualPaths.has(path)) }))
  assert.equal(collected.length, paths.length)
  assert.deepEqual(collected.map(file => file.relativePath).sort(), paths.sort())
  t.diagnostic(`Complete repository source: ${collected.length} files, ${collected.reduce((sum, file) => sum + file.size, 0)} bytes; no omitted paths`)
})

test('actual credential structures and arbitrary test-looking secrets remain blocked', () => {
  const field = (name: string, value: string) => `${name}: "${value}"`
  for (const source of [field('token', 'gh' + 'p_' + 'Z'.repeat(36)), field('key', 's' + 'k-' + '9'.repeat(32)),
    'Authorization: Bearer ' + crypto.randomUUID().replaceAll('-', ''),
    field('password', crypto.randomUUID()), field('secret', 'test-looking-but-not-reviewed'),
    field('password', 'actual-secret' + '${suffix}'),
    'DATABASE_' + 'URL=postgresql://service:' + crypto.randomUUID() + '@db.example.com/app',
    `-----BEGIN PRIVATE KEY-----\n${'MIIABqef'.repeat(16)}\n-----END PRIVATE KEY-----`]) {
    assert.equal(containsSourceCredential(source), true)
  }
})
