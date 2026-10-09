import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createHash, randomUUID } from 'node:crypto'

function load(path: string, dependencies: Record<string, unknown>, exported: string) {
  const source = stripTypeScriptTypes(readFileSync(new URL('../' + path, import.meta.url), 'utf8'), { mode: 'strip' })
    .replace(/^import\s[\s\S]*?from\s+["'][^"']+["']\s*;?\s*$/gm, '').replace(/^export\s+/gm, '')
  return new Function(...Object.keys(dependencies), source + '\nreturn ' + exported + ';')(...Object.values(dependencies))
}

function fixture(pauseAt: 'last-owner-read' | 'approval' | 'discovery' | 'result' | null = null) {
  const controller = new AbortController()
  let clock = 50, reads = 0, effects = 0
  const audits: Array<{ status: string; errorCode?: string }> = []
  let entered: () => void = () => {}, release: () => void = () => {}
  const paused = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  const pause = async (stage: typeof pauseAt) => { if (pauseAt === stage) { entered(); await gate } }
  class SyntheticJobError extends Error {
    code: string
    constructor(code: string, message: string) { super(message); this.code = code }
  }
  class SyntheticConnectorError extends Error {
    status: number
    constructor(message: string, status: number) { super(message); this.status = status }
  }
  const createContext = load('lib/jobs/worker-context.ts', {
    assertJobFence: () => {}, JobRuntimeError: SyntheticJobError, log: { info() {} },
  }, 'createJobExecutionContext')
  const context = createContext({ job: { id: 'synthetic-job', checkpoint: null },
    fence: { jobId: 'synthetic-job', workerId: 'synthetic-worker', leaseVersion: 1 },
    execution: { controller, leaseDeadline: 100 }, now: () => clock,
    budget: { assertWithinLimits() {} }, repository: {},
  })
  const tool = { name: 'search_openai_docs', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }
  const connector = { id: 'synthetic-connector', userId: 'synthetic-owner', name: 'synthetic-docs', enabled: true,
    serverUrl: pauseAt === 'approval' ? 'https://untrusted.example/mcp' : 'https://developers.openai.com/mcp',
    accessToken: null, tools: [tool] }
  const registry = load('lib/code-tools/registry.ts', { createHash }, '({ mcpToolMetadata, toolSchemaHash })')
  class Validator { getValidator() { return () => ({ valid: true }) } }
  const createBroker = load('lib/code-tools/mcp-broker.ts', {
    createHash, randomUUID, AjvJsonSchemaValidator: Validator, Ajv2020: class {}, addFormats: () => {},
    redactSensitive: (value: string) => value, ...registry, RemoteConnectorError: SyntheticConnectorError,
    isRecord: (value: unknown) => value !== null && typeof value === 'object' && !Array.isArray(value),
    MAX_CONNECTOR_APP_CALL_BYTES: 10000, MAX_CONNECTOR_RESULT_CHARS: 10000,
    loadRemoteConnectors: () => { throw new Error('Unexpected database access') },
    createRemoteTransport: () => ({}), mapRemoteTool: (value: unknown) => value,
    discoverRemoteConnectorTools: async () => { await pause('discovery'); return { tools: [tool] } },
    createRemoteClient: () => ({ connect: async () => {}, listTools: async () => ({ tools: [tool] }),
      callTool: async () => { effects++; await pause('result'); return { content: [{ type: 'text', text: 'synthetic result' }] } },
      close: async () => {} }),
  }, 'createCodeMcpBroker')
  const createUsing = (options: Record<string, unknown>) => createBroker({
      loadConnectors: async () => { if (++reads === 3) await pause('last-owner-read'); return [connector] },
      authorize: async () => { await pause('approval'); return true }, audit: (event: { status: string }) => { audits.push(event) },
      ...options,
    })
  return { paused, release, audits, context, createUsing, expire: () => { clock = 101 }, abort: () => controller.abort(),
    effects: () => effects, isAborted: () => controller.signal.aborted,
    create: () => createUsing({ userId: 'synthetic-owner', mode: 'code', signal: controller.signal,
      assertAuthority: context.assertAuthority }),
  }
}

for (const phase of ['last-owner-read', 'approval'] as const) {
  test('an expired worker lease after ' + phase + ' cannot reach MCP execution', async () => {
    const value = fixture(phase), broker = await value.create()
    const pending = broker.execute(broker.listTools()[0].toolId, {})
    await value.paused
    value.expire(); assert.equal(value.isAborted(), false); value.release()
    const result = await pending
    assert.equal(value.effects(), 0)
    assert.match(result, /CANCELLED/)
    assert.deepEqual(value.audits.map(event => event.status), ['failed'])
  })
}

test('expired discovery cannot expose tools to the following model turn', async () => {
  const value = fixture('discovery')
  const pending = value.create().then(() => 'ready', () => 'rejected')
  await value.paused
  value.expire(); value.release()
  assert.equal(await pending, 'rejected')
  assert.equal(value.effects(), 0)
})

test('an active lease still executes once and records bounded audit statuses', async () => {
  const value = fixture(), broker = await value.create()
  assert.match(await broker.execute(broker.listTools()[0].toolId, {}), /synthetic result/)
  assert.equal(value.effects(), 1)
  assert.deepEqual(value.audits.map(event => event.status), ['started', 'succeeded'])
})

test('cancellation during the final connector read stops execution before a started audit', async () => {
  const value = fixture('last-owner-read'), broker = await value.create()
  const pending = broker.execute(broker.listTools()[0].toolId, {})
  await value.paused; value.abort(); value.release()
  assert.match(await pending, /CANCELLED/)
  assert.equal(value.effects(), 0)
  assert.deepEqual(value.audits.map(event => event.status), ['failed'])
})

test('a result arriving after lease loss cannot be reported as a successful tool invocation', async () => {
  const value = fixture('result'), broker = await value.create()
  const pending = broker.execute(broker.listTools()[0].toolId, {})
  await value.paused
  assert.equal(value.effects(), 1) // cancellation cannot undo an already entered external operation
  value.expire(); value.release()
  assert.match(await pending, /CANCELLED/)
  assert.deepEqual(value.audits.map(event => event.status), ['started', 'failed'])
})

test('the real agent entrypoint passes lease authority before exposing MCP tools to the model', async () => {
  const value = fixture('discovery')
  let modelCalls = 0, runtimeCalls = 0
  const createRuntime = () => {
    runtimeCalls++
    return { canExecute: true, tools: [], events: { emit() {} }, executeTool: async () => '',
      recorder: { setTaskStatus: async () => {}, artifact: async () => {} },
      progress: { snapshot: () => ({ completed: true }) }, dispose: async () => {} }
  }
  const runLoop = async () => { modelCalls++ }
  class Writer {
    async append() {}
    async drain() {}
    text() { return 'synthetic' }
  }
  const runAgentTaskJob = load('lib/jobs/handlers/agent.ts', {
    createAgentRuntime: createRuntime, createCodeMcpBroker: value.createUsing,
    modelToolCallingDriver: { run: runLoop }, runAgentLoop: runLoop, saveAgentRunState: async () => {},
    JobEventWriter: Writer, buildCodeSystem: () => '', toOpenAI: () => [],
    restoredTrajectory: () => [], restoredHistoricalTokens: () => 0,
    chatCompletionsUrl: (url: string) => url, finalCodeTaskStatus: () => 'completed',
    jsonResult: (result: unknown) => result,
  }, 'runAgentTaskJob')
  const pending = runAgentTaskJob(value.context, { userId: 'synthetic-owner', taskId: 'synthetic-task',
    mode: 'code', repoIsPrivate: false, workspaceReady: true,
    selection: { model: 'synthetic-model', apiKey: 'test-key', accessClass: 'legacy',
      capability: { provider: { baseUrl: 'https://example.invalid', adapter: 'synthetic' } } },
  }).then(() => 'completed', () => 'rejected')
  await value.paused; value.expire(); value.release()
  assert.equal(await pending, 'rejected')
  assert.equal(runtimeCalls, 0)
  assert.equal(modelCalls, 0)
  assert.equal(value.effects(), 0)
})
