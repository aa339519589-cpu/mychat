import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { parseProcessLiveMessage, receiveProcessLiveMessage, subscribeProcessLiveEvents } from '../lib/jobs/process-live-events'

function message(jobId: string, text = '首') {
  return { type: 'mychat.job.live.v1', jobId, publishedAt: Date.now(),
    event: { kind: 'text.delta', payload: { text }, revision: 1, offset: 0, streamId: randomUUID() } }
}

test('local first text dispatch is synchronous and tenant/job isolated', () => {
  const jobId = randomUUID()
  const values: string[] = []
  const stop = subscribeProcessLiveEvents(jobId, event => { values.push(String(event.payload.text)) })
  receiveProcessLiveMessage(message(randomUUID(), 'another job'))
  assert.deepEqual(values, [])
  receiveProcessLiveMessage(message(jobId))
  assert.deepEqual(values, ['首'], 'No timer, poll, HTTP ACK or batch is required')
  stop()
  receiveProcessLiveMessage(message(jobId, 'after unsubscribe'))
  assert.deepEqual(values, ['首'])
})

test('events arriving while the stream lease is acquired retain first text', () => {
  const jobId = randomUUID()
  receiveProcessLiveMessage(message(jobId))
  const values: string[] = []
  const stop = subscribeProcessLiveEvents(jobId, event => { values.push(String(event.payload.text)) })
  assert.deepEqual(values, ['首'])
  stop()
})

test('local pipe rejects malformed/unscoped frames', () => {
  const jobId = randomUUID()
  assert.equal(parseProcessLiveMessage({ ...message(jobId), jobId: '../another' }), null)
  assert.equal(parseProcessLiveMessage({ ...message(jobId), type: 'untrusted' }), null)
  assert.equal(parseProcessLiveMessage({ ...message(jobId), event: { revision: 0, kind: 'text.delta', payload: {} } }), null)
  assert.equal(parseProcessLiveMessage({ ...message(jobId), event: { revision: 1, kind: 'text.delta', payload: {}, offset: -1 } }), null)
  assert.equal(parseProcessLiveMessage(message(jobId))?.jobId, jobId)
})
