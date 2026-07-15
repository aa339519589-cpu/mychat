import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { POST as chat } from '../app/api/chat/route'
import { POST as title } from '../app/api/chat/title/route'
import { POST as codeChat } from '../app/api/code/chat/route'
import { POST as codeApply } from '../app/api/code/apply/route'
import { jobMaintenanceMode } from '../lib/jobs/maintenance'

test('maintenance configuration is strict and keeps the legacy bridge alias', () => {
  assert.equal(jobMaintenanceMode({}), 'off')
  assert.equal(jobMaintenanceMode({ MYCHAT_MAINTENANCE_MODE: 'drain' }), 'drain')
  assert.equal(jobMaintenanceMode({ GENERATION_MAINTENANCE_MODE: 'true' }), 'drain')
  assert.throws(() => jobMaintenanceMode({ MYCHAT_MAINTENANCE_MODE: 'maybe' }))
  assert.throws(() => jobMaintenanceMode({ GENERATION_MAINTENANCE_MODE: 'maybe' }))
})

test('maintenance rejects every Job admission before parsing an invalid body', { concurrency: false }, async t => {
  const previous = process.env.MYCHAT_MAINTENANCE_MODE
  process.env.MYCHAT_MAINTENANCE_MODE = 'drain'
  t.after(() => {
    if (previous === undefined) delete process.env.MYCHAT_MAINTENANCE_MODE
    else process.env.MYCHAT_MAINTENANCE_MODE = previous
  })

  for (const [path, route] of [
    ['/api/chat', chat],
    ['/api/chat/title', title],
    ['/api/code/chat', codeChat],
    ['/api/code/apply', codeApply],
  ] as const) {
    const response = await route(new Request(`http://localhost${path}`, {
      method: 'POST',
      body: '{not-json',
      headers: { 'content-type': 'application/json' },
    }) as never)
    const body = await response.json() as { error?: { code?: string } }
    assert.equal(response.status, 503, path)
    assert.equal(response.headers.get('Retry-After'), '30', path)
    assert.equal(body.error?.code, 'MAINTENANCE_MODE', path)
  }
})

test('maintenance drain branches before any Worker or outbox run loop', () => {
  const source = readFileSync(new URL('../job-worker.ts', import.meta.url), 'utf8')
  const drain = source.indexOf("if (maintenanceMode === 'drain')")
  const workers = source.indexOf('workers.map(worker => worker.run')
  const outbox = source.indexOf('outbox.run(shutdown.signal)')
  assert.ok(drain > 0)
  assert.ok(drain < workers)
  assert.ok(drain < outbox)
})
