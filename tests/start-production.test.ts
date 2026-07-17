import assert from 'node:assert/strict'
import test from 'node:test'
import {
  resolveRuntimeRole,
  servicesForRuntimeRole,
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
