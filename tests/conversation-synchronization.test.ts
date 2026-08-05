import assert from 'node:assert/strict'
import test from 'node:test'
import { synchronizeConversationState } from '../components/literary-chat/conversation-synchronization'

test('conversation synchronization stays locked when fresh history is unavailable', async () => {
  let reconcileAttempts = 0
  const available = await synchronizeConversationState({
    hydrate: async () => {
      throw new Error('messages unavailable')
    },
    reconcile: async () => {
      reconcileAttempts += 1
      return true
    },
    isCancelled: () => false,
  })
  assert.equal(available, false)
  assert.equal(reconcileAttempts, 0)
})

test('fresh history unlocks without waiting for generation-status recovery', async () => {
  let reconcileAttempts = 0
  const available = await synchronizeConversationState({
    hydrate: async () => undefined,
    reconcile: async () => {
      reconcileAttempts += 1
      return false
    },
    isCancelled: () => false,
  })
  assert.equal(available, true)
  assert.equal(reconcileAttempts, 1)
})

test('conversation synchronization never unlocks after cancellation', async () => {
  let cancelled = false
  const available = await synchronizeConversationState({
    hydrate: async () => { cancelled = true },
    reconcile: async () => true,
    isCancelled: () => cancelled,
  })
  assert.equal(available, false)
})
