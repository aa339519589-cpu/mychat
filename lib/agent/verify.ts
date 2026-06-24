// Verification Runner：按序运行 lint → typecheck → test → build
// 每步记录 steps / tool_calls / artifacts，解析错误

import { execSync } from "child_process"
import { existsSync } from "fs"
import type { SupabaseClient } from "@supabase/supabase-js"
import { workspaceRoot } from "./workspace"
import { detectProjectCommands } from "./project-detect"
import { parseAllErrors, type VerificationErrors } from "./error-parser"
import { redactSensitive } from "./path-security"
import { addStep, addArtifact } from "./data"
import { workspaceProcessEnv } from "./shell"

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

export type VerifyResult = {
  ok: boolean
  steps: VerifyStep[]
  failedStep: string | null
  totalDurationMs: number
  summary: string
  taskStatus: string  // suggested task status
}

// ───────────── 运行单个命令 ─────────────

function runCommand(root: string, command: string, timeoutMs = 120_000): { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean } {
  try {
    const buf = execSync(command, {
      cwd: root,
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      env: workspaceProcessEnv(),
    })
    return {
      stdout: buf.slice(0, 100_000),
      stderr: "",
      exitCode: 0,
      timedOut: false,
    }
  } catch (err: any) {
    return {
      stdout: (err?.stdout ? String(err.stdout) : "").slice(0, 100_000),
      stderr: (err?.stderr ? String(err.stderr) : err?.message ?? "").slice(0, 100_000),
      exitCode: err?.status ?? err?.exitCode ?? 1,
      timedOut: err?.killed === true || err?.signal === "SIGTERM",
    }
  }
}

// ───────────── 主入口 ─────────────

export async function runVerification(
  taskId: string,
  userId: string,
  supabase: SupabaseClient,
  options: {
    install?: boolean
    steps?: ("lint" | "typecheck" | "test" | "build")[]
    timeoutPerStep?: number
  } = {},
): Promise<VerifyResult> {
  const root = workspaceRoot(taskId, userId)
  if (!existsSync(root)) {
    return { ok: false, steps: [], failedStep: null, totalDurationMs: 0, summary: "Workspace 不存在", taskStatus: "failed" }
  }

  const detected = detectProjectCommands(taskId, userId)
  const stepNames = options.steps ?? ["lint", "typecheck", "test", "build"]
  const timeout = options.timeoutPerStep ?? 120_000

  // 写入 detected commands artifact
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

  // Install（可选）
  if (options.install && detected.installCommand) {
    await addStep(supabase, userId, taskId, {
      kind: "tool_call",
      label: `安装依赖：${detected.installCommand}`,
      detail: detected.packageManager,
    })
    const ir = runCommand(root, detected.installCommand, 180_000)
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
    const command = stepMap[name]
    if (!command) {
      results.push({
        name, command: null, skipped: true,
        skipReason: "未检测到可用命令",
        passed: true, durationMs: 0,
        stdout: "", stderr: "", exitCode: null,
        parsedErrors: { totalErrors: 0, totalWarnings: 0, errors: [], summary: "" },
      })
      await addStep(supabase, userId, taskId, {
        kind: "info",
        label: `跳过 ${name}`,
        detail: "未检测到命令",
      })
      continue
    }

    await addStep(supabase, userId, taskId, {
      kind: "tool_call",
      label: `运行 ${name}`,
      detail: command,
    })

    const start = Date.now()
    const r = runCommand(root, command, timeout)
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
    results.push(step)

    // 写入 artifact
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

    if (!passed) { anyFailed = true; break }
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
