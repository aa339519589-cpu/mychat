import { Sandbox } from "e2b"
import {
  chmodSync, existsSync, mkdirSync, unlinkSync, writeFileSync,
} from "fs"
import { dirname } from "path"
import type { SupabaseClient } from "@/lib/supabase/types"
import { createWorkspaceSnapshot } from "./snapshot"
import { workspacePath } from "./workspace"
import { redactSensitive, validatePath } from "./path-security"
import { sanitizeCommandOutput } from "./command-security"
import { containsSourceCredential } from './source-credentials'
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

function sandboxCancellation(sandbox: Sandbox, signal?: AbortSignal, cleanupCreated?: () => Promise<void>): () => void {
  if (signal?.aborted && cleanupCreated) void cleanupCreated().catch(() => {})
  signal?.throwIfAborted()
  const cancel = () => { void (cleanupCreated ? cleanupCreated() : sandbox.kill()).catch(() => {}) }
  signal?.addEventListener('abort', cancel, { once: true })
  return () => signal?.removeEventListener('abort', cancel)
}

async function executeSandboxCommand(sandbox: Sandbox, command: string, opts: ShellOptions, timeoutMs: number,
  cleanupCreated?: () => Promise<void>) {
  const removeCancellation = sandboxCancellation(sandbox, opts.signal, cleanupCreated)
  try {
    const result = await sandbox.commands.run(command, {
      cwd: opts.cwd ? `${REMOTE_WORKSPACE_ROOT}/${opts.cwd}` : REMOTE_WORKSPACE_ROOT,
      timeoutMs, requestTimeoutMs: timeoutMs + 30_000,
      envs: { GIT_AUTHOR_NAME: 'mychat-agent', GIT_AUTHOR_EMAIL: 'mychat-agent@users.noreply.github.com',
        GIT_COMMITTER_NAME: 'mychat-agent', GIT_COMMITTER_EMAIL: 'mychat-agent@users.noreply.github.com' },
    })
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode, error: '' }
  } catch (caught) {
    const exitCode = Number(recordText(caught, 'exitCode'))
    return { stdout: recordText(caught, 'stdout'), stderr: recordText(caught, 'stderr'),
      error: recordText(caught, 'error') || errorMessage(caught, '命令执行失败'),
      exitCode: Number.isInteger(exitCode) ? exitCode : 1 }
  } finally { removeCancellation() }
}

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
  // Only the exact resource returned by this invocation's create call is owned for setup cleanup.
  cleanupCreated?: () => Promise<void>
}

function createdSandboxCleanup(sandbox: Sandbox): () => Promise<void> {
  let pending: Promise<void> | undefined
  return () => {
    pending ??= Promise.resolve().then(() => sandbox.kill()).then(() => undefined)
    return pending
  }
}

async function connectExistingSandbox(
  existingId: string,
  syncInitialized: boolean,
  allowOut: string[],
  signal?: AbortSignal,
): Promise<SandboxConnection | null> {
  try {
    const existing = await Sandbox.connect(existingId, { timeoutMs: SANDBOX_TIMEOUT })
    signal?.throwIfAborted()
    await existing.updateNetwork({ allowOut })
    signal?.throwIfAborted()
    return { sandbox: existing, syncInitialized }
  } catch {
    // Cancellation cannot become an instruction to provision a replacement.
    signal?.throwIfAborted()
    return null // expired, unreachable, or unable to enforce the egress policy
  }
}

async function createOwnedSandbox(
  supabase: SupabaseClient, userId: string, taskId: string, allowOut: string[], signal?: AbortSignal,
): Promise<SandboxConnection> {
  signal?.throwIfAborted()
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
  const cleanupCreated = createdSandboxCleanup(sandbox)
  try {
    signal?.throwIfAborted()
    const saved = await mergeTaskMeta(
      supabase, userId, taskId,
      { e2bSandboxId: sandbox.sandboxId, executionBackend: "e2b" },
      ["e2bSyncVersion"],
    )
    if (!saved) throw new Error("无法持久化隔离沙箱所有权")
    signal?.throwIfAborted()
    return { sandbox, syncInitialized: false, cleanupCreated }
  } catch (error) {
    try { await cleanupCreated() } catch { throw new Error("新建隔离沙箱清理未确认") }
    throw error
  }
}

async function getSandbox(
  supabase: SupabaseClient, userId: string, taskId: string, repoIsPrivate: boolean, signal?: AbortSignal,
): Promise<SandboxConnection> {
  signal?.throwIfAborted()
  const allowOut = sandboxEgressForRepository(repoIsPrivate)
  const meta = await taskMeta(supabase, userId, taskId)
  signal?.throwIfAborted()
  const existingId = typeof meta.e2bSandboxId === "string" ? meta.e2bSandboxId : null
  const syncVersion = meta.e2bSyncVersion
  if (syncVersion !== undefined && syncVersion !== null && syncVersion !== E2B_SYNC_VERSION) {
    throw new Error("沙箱同步协议版本非法，拒绝连接")
  }
  if (existingId) {
    const connected = await connectExistingSandbox(existingId, syncVersion === E2B_SYNC_VERSION, allowOut, signal)
    if (connected) return connected
  }
  return createOwnedSandbox(supabase, userId, taskId, allowOut, signal)
}

async function initializeSandbox(
  connection: SandboxConnection, supabase: SupabaseClient, userId: string, taskId: string, signal?: AbortSignal,
) {
  signal?.throwIfAborted()
  const hydration = await hydrateIsolatedWorkspace(connection.sandbox, userId, taskId, connection.syncInitialized)
  signal?.throwIfAborted()
  if (hydration.initial) {
    const saved = await mergeTaskMeta(supabase, userId, taskId, { e2bSyncVersion: E2B_SYNC_VERSION })
    if (!saved) throw new Error("无法持久化隔离沙箱同步协议版本")
  }
  signal?.throwIfAborted()
  return hydration
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
      if (containsSourceCredential(text)) throw new Error(`沙箱文件包含疑似密钥：${path}`)
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

async function isolatedFailure(caught: unknown, input: {
  cleanupCreated?: () => Promise<void>
  hydrated: boolean
  signal?: AbortSignal
  maxOutput: number
  startedAt: number
}): Promise<ShellResult> {
  let failure = caught
  if (input.cleanupCreated && (!input.hydrated || input.signal?.aborted)) {
    try { await input.cleanupCreated() } catch { failure = new Error("新建隔离沙箱清理未确认") }
  }
  return {
    stdout: "",
    stderr: sanitizeCommandOutput(redactSensitive(errorMessage(failure))).slice(0, input.maxOutput),
    exitCode: 1,
    durationMs: Date.now() - input.startedAt,
    timedOut: false,
    blocked: false,
    backend: "isolated",
  }
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
  let cleanupCreated: (() => Promise<void>) | undefined
  let hydrated = false
  let removeLifecycleCancellation = () => {}

  try {
    opts.signal?.throwIfAborted()
    const connection = await getSandbox(supabase, userId, taskId, opts.repoIsPrivate === true, opts.signal)
    const { sandbox } = connection
    cleanupCreated = connection.cleanupCreated
    if (cleanupCreated) removeLifecycleCancellation = sandboxCancellation(sandbox, opts.signal, cleanupCreated)
    const hydration = await initializeSandbox(connection, supabase, userId, taskId, opts.signal)
    hydrated = true

    const execution = await executeSandboxCommand(sandbox, command, opts, timeoutMs, cleanupCreated)
    let stdout = execution.stdout
    const { stderr, exitCode, error } = execution
    opts.signal?.throwIfAborted()

    const synced = await syncWorkspace(
      sandbox,
      supabase,
      userId,
      taskId,
      hydration.manifestText,
    )
    opts.signal?.throwIfAborted()
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
    return await isolatedFailure(caught, { cleanupCreated, hydrated, signal: opts.signal, maxOutput, startedAt })
  } finally { removeLifecycleCancellation() }
}
