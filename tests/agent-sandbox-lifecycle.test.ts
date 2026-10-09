import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'

function load(path: string, dependencies: Record<string, unknown>, exported: string) {
  const source = stripTypeScriptTypes(readFileSync(new URL('../' + path, import.meta.url), 'utf8'), { mode: 'strip' })
    .replace(/^import\s[\s\S]*?from\s+["'][^"']+["']\s*;?\s*$/gm, '').replace(/^export\s+/gm, '')
  return new Function(...Object.keys(dependencies), source + '\nreturn ' + exported + ';')(...Object.values(dependencies))
}

function fixture(options: { failSetup?: boolean; failLoop?: boolean; failCleanup?: boolean; nonresumable?: boolean } = {}) {
  const calls: string[] = []
  const controller = new AbortController()
  const { createIsolatedSandboxScope } = load('lib/agent/isolated-sandbox-scope.ts', {}, '({ createIsolatedSandboxScope })')
  const scope = createIsolatedSandboxScope({
    owner: { userId: 'synthetic-owner', taskId: 'synthetic-task', jobId: 'synthetic-job',
      workerId: 'synthetic-worker', leaseVersion: 1 },
    signal: controller.signal, assertAuthority: () => {},
    withCreationReceipt: async (create: () => Promise<string>) => ({ result: await create(), replayed: false }),
  })
  const unavailable = () => { throw new Error('Unexpected provider or external effect') }
  class SyntheticJobError extends Error {
    code: string
    constructor(code: string, message: string) { super(message); this.code = code }
  }
  class Writer {
    async append() {}
    async drain() {}
    text() { return 'synthetic completion' }
  }
  const runAgentTaskJob = load('lib/jobs/handlers/agent.ts', {
    createAgentRuntime: unavailable, modelToolCallingDriver: { run: unavailable }, runAgentLoop: unavailable,
    saveAgentRunState: unavailable, JobEventWriter: Writer, createCodeMcpBroker: unavailable,
    buildCodeSystem: () => 'synthetic instructions', toOpenAI: () => [],
    restoredTrajectory: () => [], restoredHistoricalTokens: () => 0,
    finalCodeTaskStatus: () => 'waiting_for_user', jsonResult: (value: unknown) => value,
    chatCompletionsUrl: (value: string) => value, JobRuntimeError: SyntheticJobError,
    BILLING_PRICE_VERSION: 'synthetic', platformModelCostMicros: unavailable, weightedTokenUsage: unavailable,
  }, 'runAgentTaskJob')
  const createRuntime = () => ({
    canExecute: true, tools: [], events: { emit: () => {} }, executeTool: unavailable,
    progress: { snapshot: () => ({ completed: true }) },
    recorder: {
      setTaskStatus: async () => { if (options.failSetup) throw new Error('Synthetic setup failure') },
      artifact: async () => { calls.push('artifact') },
    },
    dispose: async () => { calls.push('dispose'); await scope.dispose() },
  })
  return { calls, run: () => runAgentTaskJob({
    job: { id: 'synthetic-job', checkpoint: options.nonresumable ? { resumable: false } : null },
    fence: { jobId: 'synthetic-job', workerId: 'synthetic-worker', leaseVersion: 1 }, signal: controller.signal,
  }, {
    taskId: 'synthetic-task', userId: 'synthetic-owner', sessionId: 'synthetic-session', responseId: 'synthetic-response',
    workspaceReady: true, mode: 'code', messages: [],
    selection: { model: 'synthetic-model', apiKey: 'test-key', accessClass: 'legacy',
      capability: { provider: { baseUrl: 'https://example.invalid', adapter: 'synthetic' } } },
  }, {
    createRuntime,
    runLoop: async () => {
      await scope.acquire('synthetic-owner', 'synthetic-task', async () => {
        calls.push('create')
        return { sandbox: { sandboxId: 'synthetic-owned-sandbox' }, syncInitialized: false,
          cleanupCreated: async () => {
            calls.push('kill:synthetic-owned-sandbox')
            if (options.failCleanup) throw new Error('Synthetic kill failure')
          } }
      })
      if (options.failLoop) throw new Error('Synthetic model loop failure')
    },
  }) }
}

test('normal agent completion disposes its lease instance before returning', async () => {
  const value = fixture()
  assert.equal((await value.run()).status, 'completed')
  assert.deepEqual(value.calls, ['create', 'artifact', 'dispose', 'kill:synthetic-owned-sandbox'])
})

test('agent loop failure still disposes its own lease instance once', async () => {
  const value = fixture({ failLoop: true })
  await assert.rejects(value.run(), /Agent execution dependency failed/)
  assert.deepEqual(value.calls, ['create', 'dispose', 'kill:synthetic-owned-sandbox'])
})

test('setup failure before provider work still closes the newly constructed scope', async () => {
  const value = fixture({ failSetup: true })
  await assert.rejects(value.run(), /Agent execution dependency failed/)
  assert.deepEqual(value.calls, ['dispose'])
})

test('a nonresumable checkpoint closes the scope without creating a provider instance', async () => {
  const value = fixture({ nonresumable: true })
  await assert.rejects(value.run(), /explicitly non-resumable/)
  assert.deepEqual(value.calls, ['dispose'])
})

test('unconfirmed cleanup prevents a nominally completed agent from reporting success', async () => {
  const value = fixture({ failCleanup: true })
  await assert.rejects(value.run(), /清理未确认/)
  assert.deepEqual(value.calls, ['create', 'artifact', 'dispose', 'kill:synthetic-owned-sandbox'])
})
