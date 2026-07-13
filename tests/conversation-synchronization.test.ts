import assert from 'node:assert/strict'
import test from 'node:test'
import { synchronizeConversationState } from '../components/literary-chat/conversation-synchronization'

test('conversation synchronization keeps retrying history and generation as one authority gate', async () => {
  let hydrateAttempts = 0
  let reconcileAttempts = 0
  const available = await synchronizeConversationState({
    hydrate: async () => {
      hydrateAttempts += 1
      if (hydrateAttempts === 1) throw new Error('messages unavailable')
    },
    reconcile: async () => {
      reconcileAttempts += 1
      return reconcileAttempts >= 2
    },
    isCancelled: () => false,
    sleep: async () => undefined,
  })
  assert.equal(available, true)
  assert.equal(hydrateAttempts, 3)
  assert.equal(reconcileAttempts, 2)
})

test('conversation synchronization never unlocks after cancellation', async () => {
  let cancelled = false
  const available = await synchronizeConversationState({
    hydrate: async () => { cancelled = true },
    reconcile: async () => true,
    isCancelled: () => cancelled,
    sleep: async () => undefined,
  })
  assert.equal(available, false)
})
