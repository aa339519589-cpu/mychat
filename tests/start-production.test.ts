import assert from 'node:assert/strict'
import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import {
  resolveRuntimeRole,
  servicesForRuntimeRole,
  wireLocalProcessRelay,
} from '../scripts/start-production'

test('production runtime role defaults to the co-located deployment', () => {
  assert.equal(resolveRuntimeRole(undefined), 'all')
  assert.equal(resolveRuntimeRole(''), 'all')
})

test('production runtime roles select independently scalable processes', () => {
  const forwardedArgs = ['--port', '4100']
  const all = servicesForRuntimeRole('all', forwardedArgs, '/runtime/node')
  const web = servicesForRuntimeRole('web', forwardedArgs, '/runtime/node')
  const worker = servicesForRuntimeRole('worker', forwardedArgs, '/runtime/node')

  assert.deepEqual(all.map(service => service.name), ['web', 'worker'])
  assert.deepEqual(web, [all[0]])
  assert.deepEqual(worker, [all[1]])
  assert.deepEqual(web[0]?.args, [
    'node_modules/next/dist/bin/next',
    'start',
    '--port',
    '4100',
  ])
  assert.deepEqual(worker[0]?.args, ['--import', 'tsx', 'job-worker.ts'])
})

test('production runtime role fails closed on deployment typos', () => {
  assert.throws(
    () => resolveRuntimeRole('api'),
    /Invalid MYCHAT_RUNTIME_ROLE.*expected all, web, or worker/,
  )
})

test('co-located supervisor forwards only validated durable enqueue wakes to the worker', () => {
  const web = Object.assign(new EventEmitter(), { connected: true }) as unknown as ChildProcess
  const worker = Object.assign(new EventEmitter(), { connected: true }) as unknown as ChildProcess
  const forwarded: unknown[] = []
  worker.send = ((message: unknown) => { forwarded.push(message); return true }) as ChildProcess['send']
  web.send = (() => true) as ChildProcess['send']
  wireLocalProcessRelay(web, worker)

  web.emit('message', {
    type: 'mychat.job.wake.v1', queue: 'chat', jobId: randomUUID(), publishedAt: Date.now(),
  })
  web.emit('message', {
    type: 'mychat.job.wake.v1', queue: '../chat', jobId: randomUUID(), publishedAt: Date.now(),
  })

  assert.equal(forwarded.length, 1)
  assert.equal((forwarded[0] as { queue?: string }).queue, 'chat')
})
