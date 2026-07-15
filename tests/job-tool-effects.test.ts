import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { executeFencedToolEffect } from '../lib/jobs/tool-effects'
import { JobRuntimeError } from '../lib/jobs/errors'

const fence = {
  jobId: '00000000-0000-4000-8000-000000000001',
  workerId: 'worker-1',
  leaseVersion: 3,
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function clientWith(
  responses: Array<Record<string, unknown>>,
  calls: Array<Record<string, unknown>>,
): SupabaseClient {
  return {
    rpc: async (_name: string, args: Record<string, unknown>) => {
      calls.push(args)
      return { data: responses.shift(), error: null }
    },
  } as unknown as SupabaseClient
}

test('a succeeded tool effect replays only an integrity-checked stored result', async () => {
  const calls: Array<Record<string, unknown>> = []
  let executions = 0
  const result = await executeFencedToolEffect({
    client: clientWith([{
      recorded: false,
      replayed: true,
      reason: null,
      effectId: 'effect-1',
      status: 'succeeded',
      resultRef: { result: 'already done', sha256: digest('already done') },
    }], calls),
    fence,
    toolCallId: 'call-1',
    toolName: 'web_search',
    args: { q: 'test' },
    replaySafe: true,
    execute: async () => { executions += 1; return 'duplicated' },
  })

  assert.deepEqual(result, { result: 'already done', replayed: true })
  assert.equal(executions, 0)
  assert.equal(calls.length, 1)
})

test('a terminal tool effect without a replayable result is never executed again', async () => {
  let executions = 0
  await assert.rejects(executeFencedToolEffect({
    client: clientWith([{
      recorded: false,
      replayed: true,
      reason: null,
      effectId: 'effect-1',
      status: 'succeeded',
      resultRef: { sha256: digest('large'), bytes: 300_000, truncated: true },
    }], []),
    fence,
    toolCallId: 'call-2',
    toolName: 'publish',
    args: {},
    replaySafe: false,
    execute: async () => { executions += 1; return 'duplicated' },
  }), (error: unknown) => error instanceof JobRuntimeError && error.code === 'JOB_RETRY_UNSAFE')
  assert.equal(executions, 0)
})

test('a stored tool result with a mismatched digest fails closed', async () => {
  let executions = 0
  await assert.rejects(executeFencedToolEffect({
    client: clientWith([{
      recorded: false,
      replayed: true,
      reason: null,
      effectId: 'effect-1',
      status: 'succeeded',
      resultRef: { result: 'tampered', sha256: digest('original') },
    }], []),
    fence,
    toolCallId: 'call-3',
    toolName: 'web_search',
    args: {},
    replaySafe: true,
    execute: async () => { executions += 1; return 'duplicated' },
  }), (error: unknown) => error instanceof JobRuntimeError && error.code === 'JOB_RETRY_UNSAFE')
  assert.equal(executions, 0)
})

test('an ambiguous running effect is never blindly replayed', async () => {
  let executions = 0
  await assert.rejects(executeFencedToolEffect({
    client: clientWith([{
      recorded: false,
      replayed: true,
      reason: null,
      effectId: 'effect-1',
      status: 'running',
      resultRef: null,
    }], []),
    fence,
    toolCallId: 'call-4',
    toolName: 'publish',
    args: {},
    replaySafe: false,
    execute: async () => { executions += 1; return 'duplicated' },
  }), (error: unknown) => error instanceof JobRuntimeError && error.code === 'JOB_RETRY_UNSAFE')
  assert.equal(executions, 0)
})

test('a replay-safe failed effect can reserve a new execution generation', async () => {
  const calls: Array<Record<string, unknown>> = []
  let executions = 0
  const result = await executeFencedToolEffect({
    client: clientWith([
      {
        recorded: true, replayed: false, reason: null,
        effectId: 'effect-1', status: 'reserved', resultRef: null,
      },
      {
        recorded: true, replayed: false, reason: null,
        effectId: 'effect-1', status: 'running', resultRef: null,
      },
      {
        recorded: true, replayed: false, reason: null,
        effectId: 'effect-1', status: 'succeeded', resultRef: null,
      },
    ], calls),
    fence,
    toolCallId: 'call-retry',
    toolName: 'web_search',
    args: { q: 'retry me' },
    replaySafe: true,
    execute: async () => { executions += 1; return 'recovered' },
  })

  assert.deepEqual(result, { result: 'recovered', replayed: false })
  assert.equal(executions, 1)
  assert.deepEqual(calls.map(call => call.input_status), ['reserved', 'running', 'succeeded'])
})
