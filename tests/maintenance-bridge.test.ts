import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { POST as chat } from '../app/api/chat/route'
import { POST as title } from '../app/api/chat/title/route'
import { POST as codeChat } from '../app/api/code/chat/route'
import { POST as codeApply } from '../app/api/code/apply/route'
import { expensiveWriteMaintenanceResponse } from '../lib/api/maintenance'
import { jobMaintenanceMode } from '../lib/jobs/maintenance'

test('maintenance configuration is strict and keeps the legacy bridge alias', () => {
  assert.equal(jobMaintenanceMode({}), 'off')
  assert.equal(jobMaintenanceMode({ MYCHAT_MAINTENANCE_MODE: ' off ' }), 'off')
  assert.equal(jobMaintenanceMode({ MYCHAT_MAINTENANCE_MODE: 'false' }), 'off')
  assert.equal(jobMaintenanceMode({ MYCHAT_MAINTENANCE_MODE: '0' }), 'off')
  assert.equal(jobMaintenanceMode({ MYCHAT_MAINTENANCE_MODE: 'drain' }), 'drain')
  assert.equal(jobMaintenanceMode({ MYCHAT_MAINTENANCE_MODE: 'TRUE' }), 'drain')
  assert.equal(jobMaintenanceMode({ MYCHAT_MAINTENANCE_MODE: '1' }), 'drain')
  assert.equal(jobMaintenanceMode({ GENERATION_MAINTENANCE_MODE: 'true' }), 'drain')
  assert.equal(jobMaintenanceMode({ GENERATION_MAINTENANCE_MODE: 'false' }), 'off')
  assert.throws(() => jobMaintenanceMode({ MYCHAT_MAINTENANCE_MODE: 'maybe' }))
  assert.throws(() => jobMaintenanceMode({ GENERATION_MAINTENANCE_MODE: 'maybe' }))
})

test('maintenance admission helper is a no-op when the bridge is off', { concurrency: false }, t => {
  const current = process.env.MYCHAT_MAINTENANCE_MODE
  const legacy = process.env.GENERATION_MAINTENANCE_MODE
  process.env.MYCHAT_MAINTENANCE_MODE = 'off'
  process.env.GENERATION_MAINTENANCE_MODE = 'false'
  t.after(() => {
    if (current === undefined) delete process.env.MYCHAT_MAINTENANCE_MODE
    else process.env.MYCHAT_MAINTENANCE_MODE = current
    if (legacy === undefined) delete process.env.GENERATION_MAINTENANCE_MODE
    else process.env.GENERATION_MAINTENANCE_MODE = legacy
  })
  assert.equal(expensiveWriteMaintenanceResponse(new Request('http://localhost/api/chat')), null)
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

test('maintenance drain Worker stays alive and exits cleanly on SIGTERM', { timeout: 10_000 }, async t => {
  const child = spawn(process.execPath, ['--import', 'tsx', 'job-worker.ts'], {
    cwd: resolve(import.meta.dirname, '..'),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      MYCHAT_MAINTENANCE_MODE: 'drain',
      GENERATION_MAINTENANCE_MODE: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', chunk => { output += String(chunk) })
  child.stderr.on('data', chunk => { output += String(chunk) })
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  })

  await new Promise<void>((resolveReady, reject) => {
    const deadline = setTimeout(() => {
      reject(new Error(`Worker did not enter maintenance drain mode: ${output}`))
    }, 5_000)
    const poll = setInterval(() => {
      if (output.includes('Maintenance drain is active')) {
        clearTimeout(deadline)
        clearInterval(poll)
        resolveReady()
      } else if (child.exitCode !== null || child.signalCode !== null) {
        clearTimeout(deadline)
        clearInterval(poll)
        reject(new Error(`Worker exited before drain became active: ${output}`))
      }
    }, 10)
  })

  await new Promise(resolveWait => setTimeout(resolveWait, 400))
  assert.equal(child.exitCode, null, output)
  assert.equal(child.signalCode, null, output)

  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolveClose => {
    child.once('close', (code, signal) => resolveClose({ code, signal }))
  })
  const signalledAt = Date.now()
  assert.equal(child.kill('SIGTERM'), true)
  const result = await closed

  assert.deepEqual(result, { code: 0, signal: null }, output)
  assert.ok(Date.now() - signalledAt < 5_000, output)
  assert.match(output, /Worker shutdown requested/)
})
