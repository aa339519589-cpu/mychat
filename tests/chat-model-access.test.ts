import assert from 'node:assert/strict'
import test from 'node:test'
import { reserveTrialCall } from '../lib/chat/model-access'
import { sharedClaudeCatalogRoutes, sharedClaudeRuntimeModel } from '../lib/llm/models'

test('all shared Claude wire aliases reserve quota with the stable catalog identity', async () => {
  for (const route of sharedClaudeCatalogRoutes()) {
    let recorded: Record<string, unknown> = {}
    const client = { rpc: async (name: string, args: Record<string, unknown>) => {
      assert.equal(name, 'reserve_medium_model_trial')
      recorded = args
      // Match the production RPC constraint. Wire aliases lack the slash.
      assert.match(String(args.input_model_id), /^[A-Za-z0-9._-]+\/[A-Za-z0-9._:-]+$/)
      return { data: { allowed: true, remaining: 2, duplicate: false }, error: null }
    } }
    const result = await reserveTrialCall(client as never, 'user-id', 'generation-id', sharedClaudeRuntimeModel(route))
    assert.equal(recorded.input_model_id, route.catalogId)
    assert.deepEqual(result, { allowed: true, remaining: 2, duplicate: false })
  }
})

test('quota mapping preserves unrelated model identities and exhausted quota', async () => {
  const client = { rpc: async (_name: string, args: Record<string, unknown>) => {
    assert.equal(args.input_model_id, 'other/model')
    return { data: { allowed: false, remaining: 0, duplicate: false }, error: null }
  } }
  assert.deepEqual(await reserveTrialCall(client as never, 'user-id', 'generation-id', 'other/model'),
    { allowed: false, remaining: 0, duplicate: false })
})

test('configured Claude aliases use the same quota identity without relaxing the ledger', async () => {
  const original = process.env.CLAUDE_HAIKU_55_MODEL
  process.env.CLAUDE_HAIKU_55_MODEL = 'gateway-haiku-current'
  try {
    const client = { rpc: async (_name: string, args: Record<string, unknown>) => {
      assert.equal(args.input_model_id, 'anthropic/claude-haiku-5.5')
      return { data: null, error: { code: '42501' } }
    } }
    await assert.rejects(reserveTrialCall(client as never, 'user-id', 'generation-id', 'gateway-haiku-current'), /额度服务/)
  } finally {
    if (original === undefined) delete process.env.CLAUDE_HAIKU_55_MODEL
    else process.env.CLAUDE_HAIKU_55_MODEL = original
  }
})
