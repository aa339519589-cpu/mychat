import assert from 'node:assert/strict'
import test from 'node:test'
import { AuthRetryableFetchError, AuthSessionMissingError } from '@supabase/supabase-js'

import { isAuthDependencyUnavailable } from '../lib/api/auth-error'

test('missing auth sessions remain anonymous while dependency failures fail closed', () => {
  assert.equal(isAuthDependencyUnavailable(null), false)
  assert.equal(isAuthDependencyUnavailable(new AuthSessionMissingError()), false)
  assert.equal(isAuthDependencyUnavailable(new AuthRetryableFetchError('unavailable', 503)), true)
  assert.equal(isAuthDependencyUnavailable(new Error('network failed')), true)
})
