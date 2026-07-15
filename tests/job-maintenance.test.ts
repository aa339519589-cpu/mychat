import assert from 'node:assert/strict'
import test from 'node:test'
import { jobMaintenanceMode } from '../lib/jobs/maintenance'

test('maintenance mode unifies command admission and worker drain configuration', () => {
  assert.equal(jobMaintenanceMode({}), 'off')
  assert.equal(jobMaintenanceMode({ MYCHAT_MAINTENANCE_MODE: 'off' }), 'off')
  assert.equal(jobMaintenanceMode({ MYCHAT_MAINTENANCE_MODE: 'drain' }), 'drain')
  assert.equal(jobMaintenanceMode({ GENERATION_MAINTENANCE_MODE: 'true' }), 'drain')
  assert.equal(jobMaintenanceMode({
    MYCHAT_MAINTENANCE_MODE: 'off',
    GENERATION_MAINTENANCE_MODE: 'true',
  }), 'drain')
  assert.throws(() => jobMaintenanceMode({ MYCHAT_MAINTENANCE_MODE: 'maybe' }))
  assert.throws(() => jobMaintenanceMode({ GENERATION_MAINTENANCE_MODE: 'maybe' }))
})

