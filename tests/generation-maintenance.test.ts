import assert from 'node:assert/strict'
import test from 'node:test'
import {
  generationMaintenanceEnabled,
  generationMaintenanceResponse,
} from '../lib/generation/maintenance'

test('generation maintenance gate is opt-in and exact', () => {
  assert.equal(generationMaintenanceEnabled({}), false)
  assert.equal(generationMaintenanceEnabled({ GENERATION_MAINTENANCE_MODE: 'false' }), false)
  assert.equal(generationMaintenanceEnabled({ GENERATION_MAINTENANCE_MODE: ' TRUE ' }), true)
})

test('generation maintenance response fails new jobs closed with retry guidance', async () => {
  assert.equal(generationMaintenanceResponse({}), null)
  const response = generationMaintenanceResponse({ GENERATION_MAINTENANCE_MODE: 'true' })
  assert.ok(response)
  assert.equal(response.status, 503)
  assert.equal(response.headers.get('Cache-Control'), 'no-store')
  assert.equal(response.headers.get('Retry-After'), '120')
  assert.deepEqual(await response.json(), { error: '生成服务正在进行安全升级，请稍后重试' })
})
