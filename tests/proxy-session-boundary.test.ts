import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('dependency probes bypass Supabase session refresh while preserving request ids', async () => {
  const source = await readFile(new URL('../proxy.ts', import.meta.url), 'utf8')
  assert.match(source, /SESSION_FREE_PATHS = new Set\(\["\/api\/live", "\/api\/ready", "\/api\/metrics"\]\)/)
  assert.match(source, /SESSION_FREE_PATHS\.has\(request\.nextUrl\.pathname\)[\s\S]*return nextResponse\(\)[\s\S]*createServerClient/)
  assert.match(source, /SESSION_FREE_PATHS[\s\S]*response\.headers\.set\("x-request-id", requestId\)/)
})
