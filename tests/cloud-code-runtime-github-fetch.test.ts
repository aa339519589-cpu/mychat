import test from 'node:test'
import assert from 'node:assert/strict'
import { githubApiFetch, readFile } from '../lib/github'

test('GitHub fetch rejects other origins, credentials, non-HTTPS and nonstandard ports before network', async t => {
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => { calls++; return Response.json({}) }
  t.after(() => { globalThis.fetch = original })
  for (const url of ['https://evil.example/repos/a/b', 'http://api.github.com/repos/a/b',
    'https://api.github.com.evil.example/', 'https://api.github.com@evil.example/',
    'https://user:password@api.github.com/', 'https://api.github.com:8443/',
    'https://127.0.0.1/', 'file:///etc/passwd', 'https://api.github.com/#unexpected']) {
    assert.throws(() => githubApiFetch(url))
  }
  assert.equal(calls, 0)
})

test('GitHub fetch retains valid path/query and always refuses credential-bearing redirects', async t => {
  const original = globalThis.fetch
  const calls: Array<{ url: URL; redirect: RequestRedirect | undefined }> = []
  globalThis.fetch = async (input, init) => {
    calls.push({ url: new URL(String(input)), redirect: init?.redirect })
    return Response.json({ content: Buffer.from('selected branch content').toString('base64'), sha: 'a'.repeat(40) })
  }
  t.after(() => { globalThis.fetch = original })
  await githubApiFetch('https://api.github.com/repos/owner/repo/branches?per_page=100&page=2', { redirect: 'follow' })
  await readFile('synthetic-github-token', 'owner/repo', 'src/file.ts', undefined, 'feature/build-102')
  assert.equal(calls[0].url.hostname, 'api.github.com')
  assert.equal(calls[0].url.searchParams.get('page'), '2')
  assert.equal(calls[1].url.searchParams.get('ref'), 'feature/build-102')
  assert.ok(calls.every(call => call.redirect === 'error'))
})
