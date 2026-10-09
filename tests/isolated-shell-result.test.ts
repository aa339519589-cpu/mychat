import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'

function loadFunctions(path: string, dependencies: Record<string, unknown>, exported: string) {
  const source = readFileSync(new URL('../' + path, import.meta.url), 'utf8')
  const stripped = stripTypeScriptTypes(source, { mode: 'strip' })
    .replace(/^import\s[\s\S]*?from\s+["'][^"']+["']\s*;?\s*$/gm, '')
    .replace(/^export\s+\{[^}]*\}\s+from\s+["'][^"']+["']\s*;?\s*$/gm, '')
    .replace(/^export\s+/gm, '')
  return new Function(...Object.keys(dependencies), stripped + '\nreturn ' + exported + ';')(...Object.values(dependencies))
}

type CommandResult = { stdout: string; stderr: string; exitCode: number }
type Outcome = { error: unknown } | { result: CommandResult }
type Artifact = { kind: string; content: string; meta: { passed?: boolean; exitCode?: number } }

// The real isolated Shell, recorder decisions and both verification runners execute.
// Only SDK, storage and filesystem effects are replaced; no live service is contacted.
function fixture(outcome: Outcome) {
  const steps: string[] = []
  const artifacts: Artifact[] = []
  let verifiedDiff: string | null = 'previous-diff'
  const unavailable = () => { throw new Error('Unexpected external effect') }
  const identity = (value: string) => value
  const sandbox = {
    sandboxId: 'synthetic-result-sandbox', kill: unavailable, updateNetwork: async () => {},
    commands: { run: async () => {
      if ('error' in outcome) throw outcome.error
      return outcome.result
    } },
  }
  const client = { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({
    single: async () => ({ data: { id: 'synthetic-task', repo: 'synthetic/repo',
      meta: { e2bSandboxId: sandbox.sandboxId, e2bSyncVersion: 1 } } }),
  }) }) }) }) }
  const unknownValue = loadFunctions('lib/unknown-value.ts', {}, '({ errorMessage, recordText })')
  const runInIsolatedWorkspace = loadFunctions('lib/agent/isolated-shell.ts', {
    process: { env: {} }, Sandbox: { create: unavailable, connect: async () => sandbox },
    chmodSync: unavailable, existsSync: unavailable, mkdirSync: unavailable, unlinkSync: unavailable,
    writeFileSync: unavailable, dirname: unavailable, createWorkspaceSnapshot: unavailable, workspacePath: unavailable,
    redactSensitive: identity, validatePath: unavailable, sanitizeCommandOutput: identity,
    containsSourceCredential: unavailable, mergeTaskMeta: unavailable, ...unknownValue,
    MAX_ISOLATED_FILE_BYTES: 1024, REMOTE_WORKSPACE_ROOT: '/workspace', isolatedSandboxConfigured: () => true,
    sandboxEgressForRepository: () => [], assertIsolatedManifestUnchanged: async () => {},
    changedIsolatedWorkspacePaths: async () => [],
    hydrateIsolatedWorkspace: async () => ({ initial: false, manifestText: '{}' }),
    persistCurrentIsolatedManifest: unavailable,
  }, 'runInIsolatedWorkspace')
  const runInWorkspace = loadFunctions('lib/agent/shell.ts', {
    spawn: unavailable, existsSync: () => true, join: (...parts: string[]) => parts.join('/'),
    workspacePath: () => '/synthetic/task', checkCommand: () => ({ allowed: true }),
    sanitizeCommandOutput: identity, safeResolve: () => '/synthetic/task',
    validatePath: () => ({ ok: true }), runInIsolatedWorkspace, agentExecutionBackend: () => 'isolated',
    createRecorder: () => ({ step: async (kind: string) => { steps.push(kind) },
      recordToolCall: async (_name: string, _input: unknown, run: () => Promise<string>) => run() }),
  }, 'runInWorkspace')
  const addArtifact = async (_client: unknown, _owner: string, artifact: Artifact) => {
    artifacts.push(artifact); return { id: 'synthetic-report' }
  }
  const verifyWithCommand = loadFunctions('lib/code-tools/verification-command.ts', {
    addArtifact, lstatSync: () => ({ isFile: () => true }), runInWorkspace,
    getWorkspaceDiff: () => 'current-diff', workspaceRoot: () => '/synthetic/task',
    redactSensitive: identity, safeResolve: () => '/synthetic/task/test.js',
    commandOutput: (value: CommandResult) => value.stderr || value.stdout,
  }, 'verifyWithCommand')
  const runVerification = loadFunctions('lib/agent/verify.ts', {
    existsSync: () => true, workspaceRoot: () => '/synthetic/task',
    detectProjectCommands: () => ({ packageManager: 'none', framework: 'none', hasTypeScript: false,
      confidence: 1, notes: [], installCommand: null, lintCommand: null, typecheckCommand: null,
      testCommand: 'node test.js', buildCommand: null }),
    parseAllErrors: () => ({ totalErrors: 0, totalWarnings: 0, errors: [], summary: '' }),
    redactSensitive: identity, addStep: async () => {}, addArtifact, runInWorkspace,
  }, 'runVerification')
  const context = {
    supabase: client, wsReady: true, canExecute: true, wsUserId: 'synthetic-owner', wsTaskId: 'synthetic-task',
    emit: () => {}, state: { setVerifiedDiff: (value: string | null) => { verifiedDiff = value } },
  }
  return {
    steps, artifacts, verifiedDiff: () => verifiedDiff,
    run: () => runInWorkspace(client, 'synthetic-owner', 'synthetic-task', 'node test.js'),
    verifyRequested: () => verifyWithCommand(context, 'node test.js'),
    verifyDetected: () => runVerification('synthetic-task', 'synthetic-owner', client, { steps: ['test'], install: false }),
  }
}

for (const [name, fields] of [
  ['missing', {}],
  ['undefined', { exitCode: undefined }],
  ['null', { exitCode: null }],
  ['empty', { exitCode: '' }],
  ['whitespace', { exitCode: ' \t\r\n ' }],
  ['numeric NaN', { exitCode: Number.NaN }],
  ['text NaN', { exitCode: 'NaN' }],
  ['infinite', { exitCode: Number.POSITIVE_INFINITY }],
  ['numeric fraction', { exitCode: 0.5 }],
  ['text fraction', { exitCode: '0.5' }],
  ['non-numeric text', { exitCode: 'unavailable' }],
] as const) {
  test('SDK exception with ' + name + ' exit code remains a failure with its diagnostics', async () => {
    const value = fixture({ error: { ...fields, stdout: 'partial output', stderr: 'synthetic command diagnostic',
      message: 'synthetic SDK failure' } })
    const result = await value.run()
    assert.equal(result.exitCode, 1)
    assert.equal(result.stdout, 'partial output')
    assert.equal(result.stderr, 'synthetic command diagnostic')
    assert.equal(result.timedOut, false)
    assert.equal(value.steps.at(-1), 'failed')
    assert.equal(value.steps.includes('completed'), false)
  })
}

test('an SDK transport Error without a command result preserves its message and fails', async () => {
  const value = fixture({ error: new Error('Synthetic sandbox was killed') })
  const result = await value.run()
  assert.equal(result.exitCode, 1)
  assert.equal(result.stderr, 'Synthetic sandbox was killed')
  assert.equal(value.steps.at(-1), 'failed')
})

test('an empty thrown value uses the failure fallback instead of implying command success', async () => {
  const value = fixture({ error: undefined })
  const result = await value.run()
  assert.equal(result.exitCode, 1)
  assert.equal(result.stderr, '命令执行失败')
})

for (const [name, exitCode, expected] of [
  ['numeric', 23, 23], ['text', '17', 17], ['padded text', ' 9 ', 9],
] as const) {
  test('an explicit ' + name + ' nonzero command exit code is retained', async () => {
    const value = fixture({ error: { exitCode, stderr: 'synthetic process failure' } })
    const result = await value.run()
    assert.equal(result.exitCode, expected)
    assert.equal(result.stderr, 'synthetic process failure')
    assert.equal(value.steps.at(-1), 'failed')
  })
}

test('an explicit zero command result remains successful', async () => {
  const value = fixture({ result: { stdout: 'command completed', stderr: '', exitCode: 0 } })
  const result = await value.run()
  assert.equal(result.exitCode, 0)
  assert.equal(result.stdout, 'command completed')
  assert.equal(result.stderr, '')
  assert.equal(value.steps.at(-1), 'completed')
})

for (const exitCode of [0, '0']) {
  test('an explicitly reported ' + typeof exitCode + ' zero is distinct from an absent exit code', async () => {
    const value = fixture({ error: { exitCode, stdout: 'reported completion', stderr: '' } })
    const result = await value.run()
    assert.equal(result.exitCode, 0)
    assert.equal(result.stdout, 'reported completion')
  })
}

test('a timed out SDK exception with no exit code remains failed and timed out', async () => {
  const value = fixture({ error: new Error('Synthetic request timed out') })
  const result = await value.run()
  assert.equal(result.exitCode, 1)
  assert.equal(result.timedOut, true)
  assert.equal(result.stderr, 'Synthetic request timed out')
})

for (const mode of ['requested', 'detected'] as const) {
  test('the real ' + mode + ' verification path cannot certify an SDK exception without an exit code', async () => {
    const value = fixture({ error: new Error('Synthetic sandbox was killed') })
    if (mode === 'requested') {
      assert.match(await value.verifyRequested(), /指定测试失败/)
      assert.equal(value.verifiedDiff(), null)
    } else {
      const result = await value.verifyDetected()
      assert.equal(result.ok, false)
      assert.equal(result.failedStep, 'test')
    }
    const report = value.artifacts.find(artifact => artifact.kind === 'test_report')
    assert.ok(report)
    assert.equal(report.meta.passed, false)
    assert.equal(report.meta.exitCode, 1)
    assert.match(report.content, /Synthetic sandbox was killed/)
  })

  test('the real ' + mode + ' verification path still accepts a successful zero result', async () => {
    const value = fixture({ result: { stdout: 'synthetic tests passed', stderr: '', exitCode: 0 } })
    if (mode === 'requested') {
      assert.match(await value.verifyRequested(), /指定测试通过/)
      assert.equal(value.verifiedDiff(), 'current-diff')
    } else {
      assert.equal((await value.verifyDetected()).ok, true)
    }
    const report = value.artifacts.find(artifact => artifact.kind === 'test_report')
    assert.ok(report)
    assert.equal(report.meta.passed, true)
    assert.equal(report.meta.exitCode, 0)
  })
}
