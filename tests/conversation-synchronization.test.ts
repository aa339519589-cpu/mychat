import assert from 'node:assert/strict'
import test from 'node:test'
import { synchronizeConversationState } from '../components/literary-chat/conversation-synchronization'

test('conversation synchronization retries hydration, then reconciles without reloading history again', async () => {
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
  assert.equal(hydrateAttempts, 2)
  assert.equal(reconcileAttempts, 2)
})

test('fresh history unlocks after bounded generation-status failures', async () => {
  let reconcileAttempts = 0
  const available = await synchronizeConversationState({
    hydrate: async () => undefined,
    reconcile: async () => {
      reconcileAttempts += 1
      return false
    },
    isCancelled: () => false,
    sleep: async () => undefined,
    maxAttempts: 3,
  })
  assert.equal(available, true)
  assert.equal(reconcileAttempts, 3)
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
