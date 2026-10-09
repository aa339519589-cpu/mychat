import { addArtifact } from '@/lib/agent/data'
import { lstatSync } from 'node:fs'
import { runInWorkspace } from '@/lib/agent/shell'
import type { ShellResult } from '@/lib/agent/shell'
import { getWorkspaceDiff, workspaceRoot } from '@/lib/agent/workspace'
import { redactSensitive, safeResolve } from '@/lib/agent/path-security'
import { commandOutput } from './format'
import type { CodeToolContext } from './executor-types'

const defaults = { runInWorkspace, addArtifact, getWorkspaceDiff }

function testPassed(result: ShellResult) {
  return result.exitCode === 0 && !result.blocked && !result.timedOut
}

function requestedScriptExists(context: CodeToolContext, command: string): boolean {
  const match = /^node ([A-Za-z0-9_][A-Za-z0-9_./-]*\.(?:mjs|cjs|js))$/.exec(command)
  if (!match) return false
  const absolute = safeResolve(workspaceRoot(context.wsTaskId, context.wsUserId), match[1])
  if (!absolute) return false
  try { return lstatSync(absolute).isFile() } catch { return false }
}

function requestedTestReport(taskId: string, command: string, result: ShellResult, durationMs: number) {
  const passed = testPassed(result)
  return {
    taskId, kind: 'test_report' as const, title: `指定测试 ${passed ? '通过' : '失败'}`,
    content: redactSensitive(`Command: ${command}\nExit: ${result.exitCode ?? 'unknown'}\n${commandOutput(result)}`).slice(0, 20_000),
    meta: { name: 'test', command: redactSensitive(command), passed, exitCode: result.exitCode ?? null,
      durationMs, scope: 'requested-command' },
  }
}

/** A requested test command uses exactly the normal isolated Shell policy.
 * It cannot confer publication authority without a durable test report. */
export async function verifyWithCommand(context: CodeToolContext, command: string, dependencies = defaults): Promise<string> {
  const assertActive = () => { context.signal?.throwIfAborted(); context.assertAuthority?.() }
  assertActive()
  context.state.setVerifiedDiff(null)
  if (!context.canExecute || !context.wsReady || !context.supabase) return 'verify 需要就绪的隔离 workspace。'
  if (!requestedScriptExists(context, command)) return '验证 command 必须是单个 node 仓库内实际存在的 .js/.mjs/.cjs 脚本；禁止链接、额外参数和路径逃逸。'
  context.emit({ step: { kind: 'read', label: `验证：${redactSensitive(command).slice(0, 60)}` } })
  const startedAt = Date.now()
  const result = await dependencies.runInWorkspace(context.supabase, context.wsUserId, context.wsTaskId, command, {
    repoIsPrivate: context.repoIsPrivate, signal: context.signal,
    assertAuthority: context.assertAuthority,
    timeoutMs: Math.max(1, Math.min(120_000, context.sandboxTimeoutMs?.() ?? 120_000)),
    maxOutputChars: 16_000,
  })
  assertActive()
  const passed = testPassed(result)
  const artifact = await dependencies.addArtifact(context.supabase, context.wsUserId,
    requestedTestReport(context.wsTaskId, command, result, Date.now() - startedAt))
  assertActive()
  if ('error' in artifact) return '测试报告持久化失败，不能授予发布权限。'
  if (passed) context.state.setVerifiedDiff(dependencies.getWorkspaceDiff(context.wsTaskId, context.wsUserId))
  return `指定测试${passed ? '通过' : '失败'}，退出码：${result.exitCode ?? 'unknown'}。\n${commandOutput(result)}`
}
