import assert from 'node:assert/strict'
import test from 'node:test'
import { parseOutboxRedriveArguments } from '../scripts/redrive-outbox.mjs'

const valid = [
  '--id', '84d00000-0000-4000-8000-000000000001',
  '--lock-version', '7',
  '--key', 'manual-redrive-12345678',
  '--actor', 'operator@example.test',
  '--reason', 'provider recovered',
]

test('outbox redrive CLI requires an explicit replay key and expected lock fence', () => {
  assert.deepEqual(parseOutboxRedriveArguments(valid), {
    id: '84d00000-0000-4000-8000-000000000001',
    lockVersion: 7,
    key: 'manual-redrive-12345678',
    actor: 'operator@example.test',
    reason: 'provider recovered',
    delaySeconds: 0,
  })
  assert.throws(() => parseOutboxRedriveArguments(valid.slice(0, 4)), /Invalid/)
  assert.throws(() => parseOutboxRedriveArguments([
    ...valid.slice(0, 3), '6', ...valid.slice(4), '--unknown', 'value',
  ]), /Unknown/)
  assert.throws(() => parseOutboxRedriveArguments([
    ...valid, '--delay', '86401',
  ]), /Invalid/)
})

