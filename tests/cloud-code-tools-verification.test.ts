import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { verifyWithCommand } from '@/lib/code-tools/verification-command'
import { createCodeRunProgress } from '@/lib/code-agent/runtime'
import type { CodeToolContext } from '@/lib/code-tools/executor-types'
import type { SupabaseClient } from '@/lib/supabase/types'
import type { addArtifact } from '@/lib/agent/data'
import type { ShellOptions } from '@/lib/agent/shell'
import { workspaceRoot } from '@/lib/agent/workspace'

test('requested verification preserves private network policy and grants publish authority only after exit zero AND durable report', async t => {
  const userId = `verify-${randomUUID()}`, taskId = `verify-${randomUUID()}`
  const root = workspaceRoot(taskId, userId)
  mkdirSync(`${root}/diagnostics/cloud-code`, { recursive: true })
  writeFileSync(`${root}/diagnostics/cloud-code/fixture.mjs`, 'console.log("test")\n')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const scenario of ['pass', 'fail', 'blocked', 'artifact-failure'] as const) {
    const progress = createCodeRunProgress(() => true)
    progress.toolState.setVerifiedDiff('stale')
    const controller = new AbortController()
    const context: CodeToolContext = {
      repo: 'owner/private', repoIsPrivate: true, userId: 'user', login: 'user', token: '', defaultBranch: 'main',
      supabase: {} as SupabaseClient, wsReady: true, wsTaskId: taskId, wsUserId: userId, tavilyApiKey: '',
      emit: () => undefined, state: progress.toolState, canExecute: true, signal: controller.signal,
      sandboxTimeoutMs: () => 5_000,
    }
    const reports: Parameters<typeof addArtifact>[2][] = []
    let shellOptions: ShellOptions | undefined
    const output = await verifyWithCommand(context, 'node diagnostics/cloud-code/fixture.mjs', {
      runInWorkspace: async (_client, actualUserId, actualTaskId, command, options) => {
        assert.equal(actualUserId, userId); assert.equal(actualTaskId, taskId)
        assert.equal(command, 'node diagnostics/cloud-code/fixture.mjs')
        shellOptions = options
        return { stdout: 'actual test output', stderr: '', exitCode: scenario === 'fail' ? 1 : 0,
          timedOut: false, blocked: scenario === 'blocked', durationMs: 12 }
      },
      addArtifact: async (_client, _user, artifact) => {
        reports.push(artifact)
        return scenario === 'artifact-failure' ? { error: 'storage failed' }
          : { ...artifact, id: 'report-id' } as Awaited<ReturnType<typeof addArtifact>>
      },
      getWorkspaceDiff: () => 'current verified diff',
    })
    assert.equal(shellOptions?.repoIsPrivate, true)
    assert.equal(shellOptions?.signal, controller.signal)
    assert.equal(shellOptions?.timeoutMs, 5_000)
    assert.equal(reports[0].kind, 'test_report')
    assert.equal(reports[0].meta?.scope, 'requested-command')
    assert.equal(progress.toolState.getVerifiedDiff(), scenario === 'pass' ? 'current verified diff' : null)
    if (scenario === 'artifact-failure') assert.match(output, /持久化失败/)
    else assert.match(output, /退出码/)
  }
})

test('verification rejects fake echo checks, missing scripts, eval flags, extra argv, symlinks and path traversal before shell/artifact effects', async t => {
  const userId = `verify-${randomUUID()}`, taskId = `verify-${randomUUID()}`
  const root = workspaceRoot(taskId, userId)
  mkdirSync(root, { recursive: true })
  writeFileSync(`${root}/test.mjs`, 'console.log("test")\n')
  symlinkSync(`${root}/test.mjs`, `${root}/link.mjs`)
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const progress = createCodeRunProgress(() => true)
  const context: CodeToolContext = {
    repo: 'owner/private', repoIsPrivate: true, userId, login: 'user', token: '', defaultBranch: 'main',
    supabase: {} as SupabaseClient, wsReady: true, wsTaskId: taskId, wsUserId: userId, tavilyApiKey: '',
    emit: () => undefined, state: progress.toolState, canExecute: true,
  }
  for (const command of ['echo ok', 'node --version', 'node -e "0"', 'node --import test.mjs',
    'node test.mjs extra', 'node test.mjs; echo ok', 'node ../test.mjs', 'node /tmp/test.mjs',
    'node missing.mjs', 'node link.mjs']) {
    progress.toolState.setVerifiedDiff('stale')
    const output = await verifyWithCommand(context, command, {
      runInWorkspace: async () => { throw new Error('Unsafe shell effect') },
      addArtifact: async () => { throw new Error('Unsafe artifact effect') },
      getWorkspaceDiff: () => { throw new Error('Unsafe publication authority') },
    })
    assert.match(output, /必须是单个 node/)
    assert.equal(progress.toolState.getVerifiedDiff(), null)
  }
})
