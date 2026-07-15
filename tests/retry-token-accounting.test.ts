import assert from 'node:assert/strict'
import test from 'node:test'
import { agentTokenAccounting } from '../lib/jobs/handlers/agent'
import {
  chatTokenAccounting,
  restoredHistoricalTokens,
} from '../lib/jobs/handlers/chat-text-runtime'

function recoveredUsage(checkpointTokens: number, durableTokens: number) {
  return {
    checkpoint: {
      version: 1,
      phase: 'model.round',
      data: {},
      progress: { totalTokens: checkpointTokens },
      resumable: true,
      leaseVersion: 1,
      updatedAt: '2026-07-14T00:00:00.000Z',
    },
    usage: {
      wallTimeMs: 0,
      rawTokens: durableTokens,
      weightedTokens: durableTokens,
      costMicros: durableTokens * 3,
      sandboxTimeMs: 0,
      toolCalls: 0,
    },
  }
}

test('chat attempt two bills only new provider usage and remains settleable', () => {
  const historicalTokens = restoredHistoricalTokens(recoveredUsage(100, 120))
  const attemptTokens = 25
  const input = {
    selection: {
      customEndpoint: false,
      model: 'deepseek-chat',
      thinking: false,
      capability: { provider: { id: 'deepseek' } },
    },
    command: { usingBalance: true },
  } as Parameters<typeof chatTokenAccounting>[0]
  const entry = chatTokenAccounting(input, 'chat-retry-job', attemptTokens)[0]

  assert.equal(historicalTokens + attemptTokens, 145)
  assert.equal(entry?.rawTokens, 25)
  assert.equal(entry?.weightedTokens, 20)
  assert.equal(entry?.costMicros, 60)
  // Attempt one used 96 weighted tokens; the reservation can settle at 116.
  assert.equal(96 + Number(entry?.weightedTokens), 116)
  assert.ok(96 + Number(entry?.weightedTokens) <= 120)
})

test('agent attempt two bills only new provider usage and remains settleable', () => {
  const historicalTokens = restoredHistoricalTokens(recoveredUsage(75, 80))
  const attemptTokens = 20
  const entry = agentTokenAccounting({
    model: 'deepseek-reasoner',
    thinking: true,
    usingBalance: true,
  }, 'agent-retry-job', attemptTokens)[0]

  assert.equal(historicalTokens + attemptTokens, 100)
  assert.equal(entry?.rawTokens, 20)
  assert.equal(entry?.weightedTokens, 20)
  assert.equal(entry?.costMicros, 60)
  // Attempt one used 80 weighted tokens; no historical token is charged twice.
  assert.equal(80 + Number(entry?.weightedTokens), 100)
  assert.ok(80 + Number(entry?.weightedTokens) <= 100)
})
