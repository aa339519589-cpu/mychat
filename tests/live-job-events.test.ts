import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyOffsetDelta,
  liveJobChannelName,
  parseLiveJobEvent,
} from '../lib/jobs/live-events'

const JOB_ID = '00000000-0000-4000-8000-000000000001'
const CHANNEL_HASH_INPUT = 'test key for channel hashing only'

test('live job channel names are stable and do not expose job ids', () => {
  const first = liveJobChannelName(JOB_ID, CHANNEL_HASH_INPUT)
  const second = liveJobChannelName(JOB_ID, CHANNEL_HASH_INPUT)
  assert.equal(first, second)
  assert.ok(first?.startsWith('job-live:'))
  assert.equal(first?.includes(JOB_ID), false)
  assert.equal(liveJobChannelName(JOB_ID, ''), null)
})

test('offset deltas append, trim overlap and report gaps', () => {
  assert.deepEqual(applyOffsetDelta('abc', 3, 'def'), {
    next: 'abcdef', appended: 'def', gap: false,
  })
  assert.deepEqual(applyOffsetDelta('abcdef', 3, 'defghi'), {
    next: 'abcdefghi', appended: 'ghi', gap: false,
  })
  assert.deepEqual(applyOffsetDelta('abcdef', 3, 'def'), {
    next: 'abcdef', appended: '', gap: false,
  })
  assert.deepEqual(applyOffsetDelta('abc', 5, 'x'), {
    next: 'abc', appended: '', gap: true,
  })
})

test('live event parser rejects malformed broadcast payloads', () => {
  assert.deepEqual(parseLiveJobEvent({
    revision: 1,
    kind: 'text.delta',
    offset: 0,
    payload: { text: 'hello' },
  }), {
    revision: 1,
    kind: 'text.delta',
    offset: 0,
    payload: { text: 'hello' },
  })
  assert.equal(parseLiveJobEvent({ revision: 0, kind: 'text.delta', payload: {} }), null)
  assert.equal(parseLiveJobEvent({ revision: 1, kind: 'text.delta', offset: -1, payload: {} }), null)
})
