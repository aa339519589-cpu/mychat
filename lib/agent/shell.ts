// Workspace Shell 执行：在 workspace 内安全执行受控命令。
// 校验 task 归属 → workspace 存在 → 命令安全 → spawn → 记录 tool_call

import { spawn } from "child_process"
import { existsSync } from "fs"
import { join } from "path"
import type { SupabaseClient } from "@/lib/supabase/types"
import { workspacePath } from "./workspace"
import { checkCommand, sanitizeCommandOutput } from "./command-security"
import { safeResolve } from "./path-security"
import { createRecorder } from "./recorder"
import { runInIsolatedWorkspace } from "./isolated-shell"
import { agentExecutionBackend } from "./execution-policy"

export { localWorkspaceExecutionAllowed } from "./execution-policy"

const DEFAULT_TIMEOUT = 60_000       // 默认 60 秒
const MAX_TIMEOUT = 300_000          // 最多 5 分钟
const DEFAULT_MAX_OUTPUT = 10_000    // 默认截断长度

export type ShellResult = {
  stdout: string
  stderr: string
  exitCode: number | null
  durationMs: number
  timedOut: boolean
  blocked: boolean
  blockedReason?: string
  backend?: "isolated" | "local"
}

export type ShellOptions = {
  cwd?: string
  timeoutMs?: number
  maxOutputChars?: number
  repoIsPrivate?: boolean
}

export function workspaceProcessEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env.HOME ?? "/tmp",
    LANG: "en_US.UTF-8",
    NODE_ENV: process.env.NODE_ENV ?? "",
    GIT_AUTHOR_NAME: "mychat-agent",
    GIT_AUTHOR_EMAIL: "mychat-agent@users.noreply.github.com",
    GIT_COMMITTER_NAME: "mychat-agent",
    GIT_COMMITTER_EMAIL: "mychat-agent@users.noreply.github.com",
  }
}

// ── 执行命令 ──

export async function runInWorkspace(
  supabase: SupabaseClient,
  userId: string,
  taskId: string,
  command: string,
  opts: ShellOptions = {},
): Promise<ShellResult> {
  // ① 校验 task 归属 + workspace
  const { data: task } = await supabase
    .from("agent_tasks").select("id, repo").eq("id", taskId).eq("user_id", userId).single()
  if (!task) return blockedOut("任务不存在或不属于当前用户")

  const wsPath = workspacePath(userId, taskId)
  if (!existsSync(join(wsPath, ".git"))) return blockedOut("Workspace 未就绪，请先创建 workspace")

  // ② cwd 安全校验
  let cwd = wsPath
  if (opts.cwd) {
    const resolved = safeResolve(wsPath, opts.cwd)
    if (!resolved || !existsSync(resolved)) return blockedOut(`路径不合法或不存在: ${opts.cwd}`)
    cwd = resolved
  }

  const backend = agentExecutionBackend()
  if (backend === "disabled") {
    return blockedOut("本机命令执行已关闭；请配置 E2B_API_KEY 使用隔离沙箱")
  }
  const verdict = checkCommand(command)
  if (!verdict.allowed) return blockedOut(verdict.reason)

  // ③ recorder
  const recorder = createRecorder({ supabase, userId, taskId })

  await recorder.step("tool_call", `执行: ${command.slice(0, 80)}`)

  const safeInput = { command, cwd: opts.cwd ?? ".", backend }

  // Selecting the backend once is intentional: an E2B error is returned as an
  // isolated failure and can never cause the command to be retried on the host.
  const result = backend === "isolated"
    ? await runInIsolatedWorkspace(supabase, userId, taskId, command, opts)
    : await execCommand(
        command,
        cwd,
        Math.min(opts.timeoutMs ?? DEFAULT_TIMEOUT, MAX_TIMEOUT),
        opts.maxOutputChars ?? DEFAULT_MAX_OUTPUT,
      )

  // 写入 tool_call（已通过 recorder）
  await recorder.recordToolCall("execute", safeInput, () =>
    Promise.resolve(formatShellResult(result))
  )

  if (result.blocked) {
    await recorder.step("blocked", `命令被拦截: ${result.blockedReason}`)
  } else if (result.exitCode === 0 && !result.timedOut) {
    await recorder.step("completed", `命令完成 (${result.durationMs}ms)`)
  } else {
    await recorder.step("failed", `命令失败 (exit ${result.exitCode ?? '?'}, ${result.durationMs}ms)`)
  }

  return result
}

function formatShellResult(r: ShellResult): string {
  if (r.blocked) return `命令被安全策略拦截: ${r.blockedReason}`
  let out = ""
  if (r.stdout) out += r.stdout
  if (r.stderr) out += (out ? "\n" : "") + r.stderr
  if (r.timedOut) out += "\n(命令超时)"
  if (r.exitCode !== null && r.exitCode !== 0) out += `\n退出码: ${r.exitCode}`
  if (!out) out = "(无输出)"
  return out
}

// ── 底层 spawn 执行 ──

async function execCommand(
  command: string, cwd: string, timeoutMs: number, maxOutput: number,
): Promise<ShellResult> {
  return new Promise((resolve) => {
    const start = Date.now()
    let stdout = ""
    let stderr = ""
    let exitCode: number | null = null
    let timedOut = false
    let done = false

    const child = spawn("sh", ["-c", command], {
      cwd,
      timeout: timeoutMs,
      env: workspaceProcessEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    })

    const finish = () => {
      if (done) return
      done = true
      const durationMs = Date.now() - start
      resolve({
        stdout: sanitizeCommandOutput(stdout.slice(0, maxOutput)),
        stderr: sanitizeCommandOutput(stderr.slice(0, maxOutput)),
        exitCode,
        durationMs,
        timedOut,
        blocked: false,
        backend: "local",
      })
    }

    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString("utf-8")
      if (stdout.length > maxOutput * 2) child.kill()
    })

    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString("utf-8")
      if (stderr.length > maxOutput * 2) child.kill()
    })

    child.on("close", (code) => { exitCode = code; finish() })
    child.on("error", (err) => { stderr += err.message; exitCode = exitCode ?? 1; finish() })

    setTimeout(() => {
      if (!done) {
        timedOut = true
        exitCode = exitCode ?? 124
        child.kill("SIGTERM")
        setTimeout(() => { if (!child.killed) child.kill("SIGKILL") }, 3000)
        finish()
      }
    }, timeoutMs)
  })
}

// ── 辅助 ──

function blockedOut(reason: string): ShellResult {
  return {
    stdout: "", stderr: "", exitCode: null, durationMs: 0, timedOut: false,
    blocked: true, blockedReason: reason,
    backend: "local",
  }
}
