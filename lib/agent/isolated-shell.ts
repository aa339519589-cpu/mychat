import { Sandbox } from "e2b"
import {
  chmodSync, existsSync, mkdirSync, unlinkSync, writeFileSync,
} from "fs"
import { dirname } from "path"
import type { SupabaseClient } from "@supabase/supabase-js"
import { createWorkspaceSnapshot } from "./snapshot"
import { workspacePath } from "./workspace"
import { redactSensitive, validatePath } from "./path-security"
import { sanitizeCommandOutput } from "./command-security"
import type { ShellOptions, ShellResult } from "./shell"
import { mergeTaskMeta } from "./meta"
import { errorMessage, recordText } from '@/lib/unknown-value'
import {
  MAX_ISOLATED_FILE_BYTES,
  REMOTE_WORKSPACE_ROOT,
} from "./isolated-files"
import {
  isolatedSandboxConfigured,
  sandboxEgressForRepository,
  type AgentExecutionEnvironment,
} from "./execution-policy"
import {
  assertIsolatedManifestUnchanged,
  changedIsolatedWorkspacePaths,
  hydrateIsolatedWorkspace,
  persistCurrentIsolatedManifest,
} from "./isolated-sandbox-sync"

const SANDBOX_TIMEOUT = 30 * 60_000
const MAX_COMMAND_TIMEOUT = 15 * 60_000
const MAX_SYNC_FILES = 500
const E2B_SYNC_VERSION = 1

export const isolatedShellConfigured = (
  environment: AgentExecutionEnvironment = process.env,
) => isolatedSandboxConfigured(environment)

type TaskMeta = Record<string, unknown>

async function taskMeta(supabase: SupabaseClient, userId: string, taskId: string): Promise<TaskMeta> {
  const { data } = await supabase
    .from("agent_tasks")
    .select("meta")
    .eq("id", taskId)
    .eq("user_id", userId)
    .single()
  return (data?.meta ?? {}) as TaskMeta
}

export async function cleanupIsolatedWorkspace(
  supabase: SupabaseClient,
  userId: string,
  taskId: string,
): Promise<void> {
  if (!isolatedShellConfigured()) return
  const meta = await taskMeta(supabase, userId, taskId)
  const sandboxId = typeof meta.e2bSandboxId === "string" ? meta.e2bSandboxId : null
  if (!sandboxId) return
  try { await Sandbox.kill(sandboxId) } catch { /* already expired */ }
  await mergeTaskMeta(
    supabase,
    userId,
    taskId,
    {},
    ["e2bSandboxId", "e2bSyncVersion", "executionBackend"],
  )
}

type SandboxConnection = {
  sandbox: Sandbox
  syncInitialized: boolean
}

async function getSandbox(
  supabase: SupabaseClient,
  userId: string,
  taskId: string,
  repoIsPrivate: boolean,
): Promise<SandboxConnection> {
  const allowOut = sandboxEgressForRepository(repoIsPrivate)
  const meta = await taskMeta(supabase, userId, taskId)
  const existingId = typeof meta.e2bSandboxId === "string" ? meta.e2bSandboxId : null
  const syncVersion = meta.e2bSyncVersion
  if (syncVersion !== undefined && syncVersion !== null && syncVersion !== E2B_SYNC_VERSION) {
    throw new Error("沙箱同步协议版本非法，拒绝连接")
  }
  if (existingId) {
    try {
      const existing = await Sandbox.connect(existingId, { timeoutMs: SANDBOX_TIMEOUT })
      await existing.updateNetwork({ allowOut })
      return { sandbox: existing, syncInitialized: syncVersion === E2B_SYNC_VERSION }
    } catch { /* expired, unreachable, or unable to enforce the egress policy */ }
  }

  const options = {
    timeoutMs: SANDBOX_TIMEOUT,
    lifecycle: { onTimeout: "pause" as const, autoResume: false },
    metadata: { taskId },
    network: { allowOut },
  }
  const template = process.env.E2B_TEMPLATE?.trim()
  const sandbox = template
    ? await Sandbox.create(template, options)
    : await Sandbox.create(options)

  const saved = await mergeTaskMeta(
    supabase,
    userId,
    taskId,
    { e2bSandboxId: sandbox.sandboxId, executionBackend: "e2b" },
    ["e2bSyncVersion"],
  )
  if (!saved) {
    try { await sandbox.kill() } catch { /* best-effort cleanup after failed ownership persistence */ }
    throw new Error("无法持久化隔离沙箱所有权")
  }

  return { sandbox, syncInitialized: false }
}

async function syncWorkspace(
  sandbox: Sandbox,
  supabase: SupabaseClient,
  userId: string,
  taskId: string,
  expectedManifestText: string,
): Promise<string[]> {
  await assertIsolatedManifestUnchanged(sandbox, expectedManifestText)
  const paths = await changedIsolatedWorkspacePaths(sandbox)
  if (!paths.length) return []
  if (paths.length > MAX_SYNC_FILES) throw new Error(`命令改动了 ${paths.length} 个文件，超过同步上限`)

  type PendingChange =
    | { kind: "delete"; path: string; absolute: string }
    | { kind: "write"; path: string; absolute: string; data: Uint8Array; mode: number }

  const root = workspacePath(userId, taskId)
  const pending: PendingChange[] = []
  for (const path of paths) {
    const checked = validatePath(root, path)
    if (!checked.ok || !checked.absolute) {
      throw new Error(`沙箱返回了不安全的同步路径：${path}`)
    }
    const remotePath = `${REMOTE_WORKSPACE_ROOT}/${path}`
    const remoteExists = await sandbox.files.exists(remotePath, { requestTimeoutMs: 30_000 })
    if (!remoteExists) {
      pending.push({ kind: "delete", path, absolute: checked.absolute })
      continue
    }

    const info = await sandbox.files.getInfo(remotePath, { requestTimeoutMs: 30_000 })
    if (
      info.symlinkTarget
      || info.type !== "file"
      || !Number.isSafeInteger(info.size)
      || info.size < 0
      || info.size > MAX_ISOLATED_FILE_BYTES
      || !Number.isInteger(info.mode)
    ) {
      throw new Error(`沙箱返回了不安全的文件：${path}`)
    }
    const bytes = await sandbox.files.read(remotePath, {
      format: "bytes",
      requestTimeoutMs: 120_000,
    })
    if (bytes.byteLength !== info.size) throw new Error(`沙箱文件读取长度不一致：${path}`)
    const data = new Uint8Array(bytes)
    if (!data.includes(0)) {
      const text = new TextDecoder("utf-8", { fatal: false }).decode(data)
      if (redactSensitive(text) !== text) throw new Error(`沙箱文件包含疑似密钥：${path}`)
    }
    pending.push({
      kind: "write",
      path,
      absolute: checked.absolute,
      data,
      mode: info.mode & 0o777,
    })
  }

  const snapshot = await createWorkspaceSnapshot(taskId, userId, "auto: before isolated command sync", supabase)
  if (!snapshot.ok) throw new Error(`Snapshot 失败：${snapshot.error}`)

  const synced: string[] = []
  for (const change of pending) {
    if (change.kind === "delete") {
      if (existsSync(change.absolute)) unlinkSync(change.absolute)
      synced.push(change.path)
      continue
    }
    mkdirSync(dirname(change.absolute), { recursive: true })
    writeFileSync(change.absolute, change.data)
    chmodSync(change.absolute, change.mode)
    synced.push(change.path)
  }

  if (synced.length) {
    await persistCurrentIsolatedManifest(sandbox, userId, taskId)
    const updated = await supabase
      .from("agent_workspaces")
      .update({ status: "dirty", updated_at: new Date().toISOString() })
      .eq("task_id", taskId)
      .eq("user_id", userId)
    if (updated.error) throw new Error("无法持久化 workspace 同步状态")
  }
  return synced
}

export async function runInIsolatedWorkspace(
  supabase: SupabaseClient,
  userId: string,
  taskId: string,
  command: string,
  opts: ShellOptions = {},
): Promise<ShellResult> {
  const startedAt = Date.now()
  const maxOutput = opts.maxOutputChars ?? 10_000
  const timeoutMs = Math.min(opts.timeoutMs ?? 5 * 60_000, MAX_COMMAND_TIMEOUT)

  try {
    const connection = await getSandbox(supabase, userId, taskId, opts.repoIsPrivate === true)
    const { sandbox } = connection
    const hydration = await hydrateIsolatedWorkspace(
      sandbox,
      userId,
      taskId,
      connection.syncInitialized,
    )
    if (hydration.initial) {
      const saved = await mergeTaskMeta(supabase, userId, taskId, { e2bSyncVersion: E2B_SYNC_VERSION })
      if (!saved) throw new Error("无法持久化隔离沙箱同步协议版本")
    }

    let stdout = ""
    let stderr = ""
    let exitCode = 0
    let error = ""
    try {
      const result = await sandbox.commands.run(command, {
        cwd: opts.cwd ? `${REMOTE_WORKSPACE_ROOT}/${opts.cwd}` : REMOTE_WORKSPACE_ROOT,
        timeoutMs,
        requestTimeoutMs: timeoutMs + 30_000,
        envs: {
          GIT_AUTHOR_NAME: "mychat-agent",
          GIT_AUTHOR_EMAIL: "mychat-agent@users.noreply.github.com",
          GIT_COMMITTER_NAME: "mychat-agent",
          GIT_COMMITTER_EMAIL: "mychat-agent@users.noreply.github.com",
        },
      })
      stdout = result.stdout
      stderr = result.stderr
      exitCode = result.exitCode
    } catch (caught) {
      stdout = recordText(caught, 'stdout')
      stderr = recordText(caught, 'stderr')
      error = recordText(caught, 'error') || errorMessage(caught, "命令执行失败")
      const caughtExitCode = Number(recordText(caught, 'exitCode'))
      exitCode = Number.isInteger(caughtExitCode) ? caughtExitCode : 1
    }

    const synced = await syncWorkspace(
      sandbox,
      supabase,
      userId,
      taskId,
      hydration.manifestText,
    )
    if (synced.length) stdout += `${stdout ? "\n" : ""}已同步 ${synced.length} 个文件回 workspace。`
    return {
      stdout: sanitizeCommandOutput(redactSensitive(stdout)).slice(0, maxOutput),
      stderr: sanitizeCommandOutput(redactSensitive(stderr || error)).slice(0, maxOutput),
      exitCode,
      durationMs: Date.now() - startedAt,
      timedOut: /timeout|timed out/i.test(error),
      blocked: false,
      backend: "isolated",
    }
  } catch (caught) {
    return {
      stdout: "",
      stderr: sanitizeCommandOutput(redactSensitive(errorMessage(caught))).slice(0, maxOutput),
      exitCode: 1,
      durationMs: Date.now() - startedAt,
      timedOut: false,
      blocked: false,
      backend: "isolated",
    }
  }
}
