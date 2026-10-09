// Verification Runner：按序运行 lint → typecheck → test → build
// 每步记录 steps / tool_calls / artifacts，解析错误

import { existsSync } from "fs"
import type { SupabaseClient } from "@/lib/supabase/types"
import { workspaceRoot } from "./workspace"
import { detectProjectCommands } from "./project-detect"
import { parseAllErrors, type VerificationErrors } from "./error-parser"
import { redactSensitive } from "./path-security"
import { addStep, addArtifact } from "./data"
import { runInWorkspace } from "./shell"

type VerifyStep = {
  name: string
  command: string | null
  skipped: boolean
  skipReason?: string
  passed: boolean
  durationMs: number
  stdout: string
  stderr: string
  exitCode: number | null
  parsedErrors: VerificationErrors
}

function verificationTimeout(options: { totalTimeoutMs?: number }) {
  const deadline = options.totalTimeoutMs === undefined ? null : Date.now() + Math.max(1, options.totalTimeoutMs)
  return (maximum: number) => deadline === null ? maximum : Math.max(1, Math.min(maximum, deadline - Date.now()))
}

export type VerifyResult = {
  ok: boolean
  steps: VerifyStep[]
  failedStep: string | null
  totalDurationMs: number
  summary: string
  taskStatus: string  // suggested task status
}

// ───────────── 运行单个命令 ─────────────

async function runCommand(
  supabase: SupabaseClient,
  userId: string,
  taskId: string,
  command: string,
  timeoutMs = 120_000,
  repoIsPrivate = false,
  signal?: AbortSignal,
  assertAuthority?: () => void,
): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }> {
  const result = await runInWorkspace(supabase, userId, taskId, command, {
    repoIsPrivate,
    timeoutMs,
    maxOutputChars: 100_000,
    signal,
    assertAuthority,
  })
  return {
    stdout: result.stdout,
    stderr: result.blocked ? result.blockedReason ?? "命令被拦截" : result.stderr,
    exitCode: result.blocked ? 1 : result.exitCode,
    timedOut: result.timedOut,
  }
}

type VerificationOptions = {
  signal?: AbortSignal
  assertAuthority?: () => void
  install?: boolean
  steps?: ("lint" | "typecheck" | "test" | "build")[]
  timeoutPerStep?: number
  totalTimeoutMs?: number
  repoIsPrivate?: boolean
}

async function recordProjectDetection(supabase: SupabaseClient, userId: string, taskId: string,
  detected: ReturnType<typeof detectProjectCommands>, assertActive: () => void): Promise<void> {
  assertActive()
  await addArtifact(supabase, userId, {
    taskId,
    kind: "build_report",
    title: "项目检测结果",
    content: JSON.stringify({
      packageManager: detected.packageManager,
      framework: detected.framework,
      hasTypeScript: detected.hasTypeScript,
      confidence: detected.confidence,
      notes: detected.notes,
    }, null, 2),
    meta: {
      installCommand: detected.installCommand,
      lintCommand: detected.lintCommand,
      typecheckCommand: detected.typecheckCommand,
      testCommand: detected.testCommand,
      buildCommand: detected.buildCommand,
    },
  })

  assertActive()
}

async function recordVerificationReport(supabase: SupabaseClient, userId: string, taskId: string,
  step: VerifyStep, r: Awaited<ReturnType<typeof runCommand>>, assertActive: () => void): Promise<void> {
  assertActive()
  const { name, command, passed, durationMs: duration, parsedErrors: parsed } = step
  await addArtifact(supabase, userId, {
    taskId,
    kind: name === "build" ? "build_report" : name === "test" ? "test_report" : "log",
    title: `${name} ${passed ? "✓" : "✗"} (${duration}ms)`,
    content: [
      `Command: ${command}`,
      `Exit: ${r.exitCode}`,
      passed ? "✓ 通过" : `✗ 失败：${parsed.summary}`,
      "",
      "```",
      redactSensitive(r.stderr || r.stdout).slice(0, 5000),
      "```",
    ].join("\n"),
    meta: {
      command, name, passed, durationMs: duration, exitCode: r.exitCode,
      totalErrors: parsed.totalErrors, totalWarnings: parsed.totalWarnings,
      files: [...new Set(parsed.errors.map(e => e.file).filter(Boolean))],
    },
  })
  assertActive()
}

async function runVerificationStep(name: string, command: string | null, input: {
  supabase: SupabaseClient; userId: string; taskId: string; options: VerificationOptions
  assertActive: () => void; remainingTimeout: (maximum: number) => number; timeout: number
}): Promise<VerifyStep> {
  const { supabase, userId, taskId, options, assertActive, remainingTimeout, timeout } = input
  assertActive()

  if (!command) {
    const skipped: VerifyStep = {
      name, command: null, skipped: true,
      skipReason: "未检测到可用命令",
      passed: true, durationMs: 0,
      stdout: "", stderr: "", exitCode: null,
      parsedErrors: { totalErrors: 0, totalWarnings: 0, errors: [], summary: "" },
    }
    await addStep(supabase, userId, taskId, {
      kind: "info",
      label: `跳过 ${name}`,
      detail: "未检测到命令",
    })
    assertActive()
    return skipped
  }

  await addStep(supabase, userId, taskId, {
    kind: "tool_call",
    label: `运行 ${name}`,
    detail: command,
  })
  assertActive()

  const start = Date.now()
  const r = await runCommand(
    supabase,
    userId,
    taskId,
    command,
    remainingTimeout(timeout),
    options.repoIsPrivate === true,
    options.signal,
    options.assertAuthority,
  )
  assertActive()
  const duration = Date.now() - start

  const parsed = parseAllErrors(r.stdout, r.stderr, command)
  const passed = r.exitCode === 0 && parsed.totalErrors === 0

  const step: VerifyStep = {
    name, command, skipped: false,
    passed, durationMs: duration,
    stdout: redactSensitive(r.stdout),
    stderr: redactSensitive(r.stderr),
    exitCode: r.exitCode,
    parsedErrors: parsed,
  }

  await recordVerificationReport(supabase, userId, taskId, step, r, assertActive)
  assertActive()

  return step
}

async function prepareDependencies(supabase: SupabaseClient, userId: string, taskId: string,
  detected: ReturnType<typeof detectProjectCommands>, options: VerificationOptions,
  remainingTimeout: (maximum: number) => number, assertActive: () => void): Promise<VerifyResult | null> {
  assertActive()
  if (options.install && detected.installCommand) {
    await addStep(supabase, userId, taskId, {
      kind: "tool_call",
      label: `安装依赖：${detected.installCommand}`,
      detail: detected.packageManager,
    })
    assertActive()
    const ir = await runCommand(
      supabase,
      userId,
      taskId,
      detected.installCommand,
      remainingTimeout(180_000),
      options.repoIsPrivate === true,
      options.signal,
      options.assertAuthority,
    )
    assertActive()
    if (ir.exitCode !== 0) {
      return {
        ok: false,
        steps: [{
          name: "install", command: detected.installCommand, skipped: false,
          passed: false, durationMs: 0,
          stdout: ir.stdout, stderr: ir.stderr, exitCode: ir.exitCode,
          parsedErrors: parseAllErrors(ir.stdout, ir.stderr, detected.installCommand),
        }],
        failedStep: "install",
        totalDurationMs: 0,
        summary: `依赖安装失败：${ir.stderr.slice(0, 500)}`,
        taskStatus: "failed",
      }
    }
  }

  return null
}

// ───────────── 主入口 ─────────────

export async function runVerification(
  taskId: string,
  userId: string,
  supabase: SupabaseClient,
  options: VerificationOptions = {},
): Promise<VerifyResult> {
  const assertActive = () => { options.signal?.throwIfAborted(); options.assertAuthority?.() }
  assertActive()
  const root = workspaceRoot(taskId, userId)
  if (!existsSync(root)) {
    return { ok: false, steps: [], failedStep: null, totalDurationMs: 0, summary: "Workspace 不存在", taskStatus: "failed" }
  }

  const detected = detectProjectCommands(taskId, userId)
  const stepNames = options.steps ?? ["lint", "typecheck", "test", "build"]
  const timeout = options.timeoutPerStep ?? 120_000
  const remainingTimeout = verificationTimeout(options)

  await recordProjectDetection(supabase, userId, taskId, detected, assertActive)
  assertActive()

  const dependencyFailure = await prepareDependencies(
    supabase, userId, taskId, detected, options, remainingTimeout, assertActive,
  )
  assertActive()
  if (dependencyFailure) return dependencyFailure

  const stepMap: Record<string, string | null> = {
    lint: detected.lintCommand,
    typecheck: detected.typecheckCommand,
    test: detected.testCommand,
    build: detected.buildCommand,
  }

  const results: VerifyStep[] = []
  const totalStart = Date.now()
  let anyFailed = false

  for (const name of stepNames) {
    const step = await runVerificationStep(name, stepMap[name], {
      supabase, userId, taskId, options, assertActive, remainingTimeout, timeout,
    })
    assertActive()
    results.push(step)
    if (!step.passed) { anyFailed = true; break }
  }

  const totalDuration = Date.now() - totalStart
  const failedStep = results.find(s => !s.passed)

  return {
    ok: !anyFailed,
    steps: results,
    failedStep: failedStep?.name ?? null,
    totalDurationMs: totalDuration,
    summary: anyFailed
      ? `${failedStep?.name} 失败：${failedStep?.parsedErrors.summary ?? "未知错误"}`
      : "全部验证通过",
    taskStatus: anyFailed ? "failed" : "completed",
  }
}
