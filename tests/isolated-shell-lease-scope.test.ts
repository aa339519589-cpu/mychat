import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { createHash } from 'node:crypto'

// These execute production worker-context, tool-effect and isolated-shell functions.
// Provider, filesystem and database responses are controlled in-process fixtures.
function load(path: string, dependencies: Record<string, unknown>, exported: string) {
  const source = stripTypeScriptTypes(readFileSync(new URL('../' + path, import.meta.url), 'utf8'), { mode: 'strip' })
    .replace(/^import\s[\s\S]*?from\s+["'][^"']+["']\s*;?\s*$/gm, '')
    .replace(/^export\s+/gm, '')
  return new Function(...Object.keys(dependencies), source + '\nreturn ' + exported + ';')(...Object.values(dependencies))
}

function gate() {
  let open: () => void = () => {}
  const promise = new Promise<void>(resolve => { open = resolve })
  return { promise, open }
}

function fixture() {
  const scopeFunctions = load('lib/agent/isolated-sandbox-scope.ts', {},
    '({ createIsolatedSandboxScope, isIsolatedSandboxScope, sandboxCancellation, createdSandboxCleanup })')
  const calls: string[] = []
  const oldStarted = gate(), nextStarted = gate(), killStarted = gate(), finishKill = gate()
  const oldController = new AbortController(), nextController = new AbortController()
  const taskId = '00000000-0000-4000-8000-000000000002'
  const jobId = '00000000-0000-4000-8000-000000000001'
  let meta: Record<string, unknown> = {}
  let currentLease = 1
  let completeNext: () => void = () => {}
  type Resource = { id: string; alive: boolean; reject: Array<(error: Error) => void> }
  const resources = new Map<string, Resource>()
  const effects = new Map<string, { status: string; resultRef: unknown }>()
  class SyntheticJobError extends Error {
    code: string
    constructor(code: string, message: string) { super(message); this.code = code }
  }
  const createContext = load('lib/jobs/worker-context.ts', {
    assertJobFence: (fence: { jobId: string; leaseVersion: number }) => {
      assert.equal(fence.jobId, jobId); assert.ok(fence.leaseVersion > 0)
    }, JobRuntimeError: SyntheticJobError, log: { info() {} },
  }, 'createJobExecutionContext')
  const context = (version: number, controller: AbortController) => createContext({
    job: { id: jobId, checkpoint: null }, fence: { jobId, workerId: 'synthetic-worker-' + version, leaseVersion: version },
    execution: { controller, leaseDeadline: 100 }, now: () => 50,
    budget: { assertWithinLimits() {} }, repository: {},
  })
  const oldContext = context(1, oldController), nextContext = context(2, nextController)
  function connection(resource: Resource) {
    return {
      sandboxId: resource.id,
      updateNetwork: async () => {},
      kill: async () => {
        calls.push('kill-request:' + resource.id); killStarted.open()
        await finishKill.promise
        calls.push('kill-complete:' + resource.id); resource.alive = false
        resource.reject.forEach(reject => reject(new Error('Synthetic sandbox was killed')))
      },
      commands: { run: async (command: string) => new Promise((resolve, reject) => {
        resource.reject.push(reject)
        if (command === 'node old.js') { calls.push('old-command:' + resource.id); oldStarted.open() }
        else {
          calls.push('new-command:' + resource.id)
          completeNext = () => { if (resource.alive) resolve({ stdout: 'new lease completed', stderr: '', exitCode: 0 }) }
          nextStarted.open()
        }
      }) },
    }
  }
  const Sandbox = {
    create: async () => {
      const resource: Resource = { id: 'synthetic-sandbox-' + (resources.size + 1), alive: true, reject: [] }
      resources.set(resource.id, resource); calls.push('create:' + resource.id)
      return connection(resource)
    },
    connect: async (id: string) => {
      calls.push('connect:' + id)
      const resource = resources.get(id)
      if (!resource || !resource.alive) throw new Error('Synthetic resource is unavailable')
      return connection(resource)
    },
  }
  const client = {
    from: () => ({ select: () => ({ eq: () => ({ eq: () => ({
      single: async () => ({ data: { meta: { ...meta } } }),
    }) }) }) }),
    rpc: async (name: string, input: Record<string, unknown>) => {
      assert.equal(name, 'record_job_tool_effect')
      const version = Number(input.input_lease_version)
      calls.push('effect-request:' + version + ':' + input.input_tool_call_id + ':' + input.input_status)
      if (version !== currentLease || input.input_worker_id !== 'synthetic-worker-' + currentLease) {
        calls.push('fence-denied:' + version)
        return { data: { recorded: false, replayed: false, reason: 'stale_fence', status: null }, error: null }
      }
      const key = String(input.input_effect_key)
      const existing = effects.get(key)
      if (existing && ['succeeded', 'compensated'].includes(existing.status)) {
        return { data: { recorded: false, replayed: true, status: existing.status, resultRef: existing.resultRef }, error: null }
      }
      if (existing?.status === 'running' && input.input_status === 'reserved') {
        return { data: null, error: { code: '55000' } } // invalid_tool_effect_transition in the current SQL
      }
      const value = { status: String(input.input_status), resultRef: input.input_result_ref ?? null }
      effects.set(key, value)
      calls.push('effect-accepted:' + version + ':' + input.input_tool_call_id + ':' + input.input_status)
      return { data: { recorded: true, replayed: false, ...value }, error: null }
    },
  }
  const unavailable = () => { throw new Error('Unexpected host effect') }
  const unknownValue = load('lib/unknown-value.ts', {}, '({ recordText, errorMessage })')
  const run = load('lib/agent/isolated-shell.ts', {
    ...scopeFunctions, process: { env: {} }, Sandbox, chmodSync: unavailable, existsSync: unavailable, mkdirSync: unavailable,
    unlinkSync: unavailable, writeFileSync: unavailable, dirname: unavailable, createWorkspaceSnapshot: unavailable,
    workspacePath: unavailable, redactSensitive: (value: string) => value, validatePath: unavailable,
    sanitizeCommandOutput: (value: string) => value, containsSourceCredential: unavailable, ...unknownValue,
    mergeTaskMeta: async (_client: unknown, _owner: string, _task: string, patch: Record<string, unknown>) => {
      meta = { ...meta, ...patch }; return true
    },
    MAX_ISOLATED_FILE_BYTES: 1024, REMOTE_WORKSPACE_ROOT: '/workspace', isolatedSandboxConfigured: () => true,
    sandboxEgressForRepository: () => [], assertIsolatedManifestUnchanged: async () => {},
    changedIsolatedWorkspacePaths: async () => [],
    hydrateIsolatedWorkspace: async () => ({ initial: false, manifestText: '{}' }), persistCurrentIsolatedManifest: unavailable,
  }, 'runInIsolatedWorkspace')
  const executeEffect = load('lib/jobs/tool-effects.ts', {
    JobRuntimeError: SyntheticJobError,
    sha256JobBytes: (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex'),
  }, 'executeFencedToolEffect')
  const makeScope = (ctx: typeof oldContext) => scopeFunctions.createIsolatedSandboxScope({
    owner: { ...ctx.fence, userId: 'synthetic-owner', taskId }, signal: ctx.signal, assertAuthority: ctx.assertAuthority,
    withCreationReceipt: (execute: () => Promise<string>) => executeEffect({
      client, fence: ctx.fence, toolCallId: 'sandbox:' + ctx.fence.leaseVersion,
      toolName: 'isolated_sandbox.create', args: { taskId, version: ctx.fence.leaseVersion }, replaySafe: false, execute,
    }),
  })
  const oldScope = makeScope(oldContext), nextScope = makeScope(nextContext)
  const runTool = (ctx: typeof oldContext, toolCallId: string, command: string) => executeEffect({
    client, fence: ctx.fence, toolCallId, toolName: 'execute', args: { command }, replaySafe: false,
    execute: async () => JSON.stringify(await run(client, 'synthetic-owner', taskId, command,
      { signal: ctx.signal, assertAuthority: ctx.assertAuthority, sandboxScope: ctx === oldContext ? oldScope : nextScope })),
  }).then((result: { result: string }) => ({ ok: true, result: JSON.parse(result.result) }),
    (error: SyntheticJobError) => ({ ok: false, code: error.code }))
  return {
    calls, oldStarted, nextStarted, killStarted, finishKill,
    disposeNext: () => nextScope.dispose(),
    runWithScope: (scope: unknown) => run(client, 'synthetic-owner', taskId, 'node next.js', { sandboxScope: scope }),
    startOld: () => runTool(oldContext, 'old-call', 'node old.js'),
    claimNext: () => { currentLease = 2 },
    startNext: () => runTool(nextContext, 'new-call', 'node next.js'),
    retryOldCall: () => runTool(nextContext, 'old-call', 'node old.js'),
    cancelOld: () => oldController.abort(new SyntheticJobError('JOB_LEASE_STALE', 'Synthetic lease was replaced')),
    completeNext: () => completeNext(),
  }
}

for (const timing of ['after-adoption', 'already-in-flight'] as const) {
  test('a stale lease cannot kill the replacement lease instance: ' + timing, async () => {
    const value = fixture()
    const old = value.startOld()
    await value.oldStarted.promise
    value.claimNext()
    if (timing === 'already-in-flight') {
      value.cancelOld()
      await value.killStarted.promise
    }
    const next = value.startNext()
    await value.nextStarted.promise
    if (timing === 'after-adoption') {
      value.cancelOld()
      await value.killStarted.promise
    }
    value.finishKill.open()
    await new Promise(resolve => setImmediate(resolve))
    value.completeNext()
    const [oldResult, nextResult] = await Promise.all([old, next])
    assert.deepEqual(oldResult, { ok: false, code: 'JOB_LEASE_STALE' })
    assert.equal(nextResult.ok, true)
    assert.equal(nextResult.result.exitCode, 0)
    assert.equal(nextResult.result.stdout, 'new lease completed')
    assert.equal(nextResult.result.stderr, '')
    assert.equal(value.calls.filter(call => call.startsWith('create:')).length, 2)
    assert.equal(value.calls.some(call => call.startsWith('connect:')), false)
    assert.ok(value.calls.includes('effect-accepted:2:new-call:running'))
    assert.ok(value.calls.includes('fence-denied:1'))
    assert.ok(value.calls.includes('kill-complete:synthetic-sandbox-1'))
    if (timing === 'already-in-flight') {
      assert.ok(value.calls.indexOf('kill-request:synthetic-sandbox-1') < value.calls.indexOf('create:synthetic-sandbox-2'))
    }
    assert.equal(value.calls.includes('kill-request:synthetic-sandbox-2'), false)
    await value.disposeNext()
    assert.equal(value.calls.filter(call => call === 'kill-complete:synthetic-sandbox-2').length, 1)
  })
}

test('tool-effect fencing rejects replay of the exact old running call but admits a distinct call', async () => {
  const value = fixture()
  const old = value.startOld()
  await value.oldStarted.promise
  value.claimNext()
  assert.deepEqual(await value.retryOldCall(), { ok: false, code: 'JOB_DEPENDENCY_UNAVAILABLE' })
  assert.equal(value.calls.filter(call => call.startsWith('connect:')).length, 0)
  const next = value.startNext()
  await value.nextStarted.promise
  value.completeNext()
  const result = await next
  assert.equal(result.ok, true)
  assert.equal(result.result.stdout, 'new lease completed')
  value.cancelOld(); value.finishKill.open()
  assert.deepEqual(await old, { ok: false, code: 'JOB_LEASE_STALE' })
  await value.disposeNext()
})


test('an object supplied in a scope-shaped field cannot acquire or kill a sandbox', async () => {
  const value = fixture()
  let invoked = false
  const result = await value.runWithScope({ run: () => { invoked = true }, acquire: () => { invoked = true } })
  assert.equal(result.exitCode, 1)
  assert.match(result.stderr, /必须由 Worker 创建/)
  assert.equal(invoked, false)
  assert.deepEqual(value.calls, [])
  await value.disposeNext()
})
