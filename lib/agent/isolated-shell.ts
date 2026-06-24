import { Sandbox } from "e2b"
import { createHash } from "crypto"
import {
  chmodSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync,
} from "fs"
import { dirname } from "path"
import type { SupabaseClient } from "@supabase/supabase-js"
import { createWorkspaceSnapshot } from "./snapshot"
import { listWorkspaceFiles, workspacePath } from "./workspace"
import { redactSensitive, validatePath } from "./path-security"
import { sanitizeCommandOutput } from "./command-security"
import type { ShellOptions, ShellResult } from "./shell"

const REMOTE_ROOT = "/home/user/workspace"
const SANDBOX_TIMEOUT = 30 * 60_000
const MAX_COMMAND_TIMEOUT = 15 * 60_000
const MAX_FILE_BYTES = 5 * 1024 * 1024
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024
const MAX_SYNC_FILES = 500
const BATCH_SIZE = 100
const PRIVATE_CONFIGS = new Set([".npmrc", ".pypirc", ".netrc", ".yarnrc.yml"])

export const isolatedShellConfigured = () => Boolean(process.env.E2B_API_KEY)

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
  delete meta.e2bSandboxId
  delete meta.executionBackend
  await supabase
    .from("agent_tasks")
    .update({ meta, updated_at: new Date().toISOString() })
    .eq("id", taskId)
    .eq("user_id", userId)
}

async function getSandbox(supabase: SupabaseClient, userId: string, taskId: string): Promise<Sandbox> {
  const meta = await taskMeta(supabase, userId, taskId)
  const existingId = typeof meta.e2bSandboxId === "string" ? meta.e2bSandboxId : null
  if (existingId) {
    try { return await Sandbox.connect(existingId, { timeoutMs: SANDBOX_TIMEOUT }) } catch { /* expired */ }
  }

  const options = {
    timeoutMs: SANDBOX_TIMEOUT,
    lifecycle: { onTimeout: "pause" as const, autoResume: false },
    metadata: { taskId },
  }
  const template = process.env.E2B_TEMPLATE?.trim()
  const sandbox = template
    ? await Sandbox.create(template, options)
    : await Sandbox.create(options)

  await supabase
    .from("agent_tasks")
    .update({
      meta: { ...meta, e2bSandboxId: sandbox.sandboxId, executionBackend: "e2b" },
      updated_at: new Date().toISOString(),
    })
    .eq("id", taskId)
    .eq("user_id", userId)

  return sandbox
}

export async function startAgentRecoveryWatchdog(
  supabase: SupabaseClient,
  userId: string,
  taskId: string,
  recoveryUrl: string,
  recoveryToken: string,
): Promise<void> {
  if (!isolatedShellConfigured() || !recoveryUrl || !recoveryToken) return
  const tokenHash = createHash("sha256").update(recoveryToken).digest("hex")
  const meta = await taskMeta(supabase, userId, taskId)
  if (meta.agentWatchdogTokenHash === tokenHash) return

  const sandbox = await getSandbox(supabase, userId, taskId)
  const script = [
    "const wait=ms=>new Promise(r=>setTimeout(r,ms));",
    "async function run(){for(;;){await wait(30000);try{",
    "const r=await fetch(process.env.AGENT_RECOVERY_URL,{method:'POST',headers:{'x-agent-resume':process.env.AGENT_RECOVERY_TOKEN}});",
    "if(r.status===410||r.status===401){process.exit(0)}",
    "}catch{}}}run();",
  ].join("")
  await sandbox.commands.run(`node -e ${JSON.stringify(script)}`, {
    background: true,
    envs: { AGENT_RECOVERY_URL: recoveryUrl, AGENT_RECOVERY_TOKEN: recoveryToken },
  })

  const latest = await taskMeta(supabase, userId, taskId)
  await supabase.from("agent_tasks").update({
    meta: { ...latest, agentWatchdogTokenHash: tokenHash },
    updated_at: new Date().toISOString(),
  }).eq("id", taskId).eq("user_id", userId)
}

function localFiles(userId: string, taskId: string) {
  const root = workspacePath(userId, taskId)
  const listed = listWorkspaceFiles(taskId, userId, undefined, 10_000)
  if (!listed.ok) throw new Error(listed.error)
  if (listed.data.truncated) throw new Error("Workspace 文件超过 10000 个，拒绝不完整同步")

  let total = 0
  const files: { path: string; data: ArrayBuffer }[] = []
  for (const path of listed.data.files) {
    const lowerPath = path.toLowerCase()
    const fileName = lowerPath.split("/").at(-1) ?? ""
    if (PRIVATE_CONFIGS.has(fileName) || lowerPath.endsWith(".docker/config.json")) {
      throw new Error(`敏感配置不会上传到沙箱：${path}`)
    }
    const checked = validatePath(root, path)
    if (!checked.ok) continue
    const size = statSync(checked.absolute!).size
    if (size > MAX_FILE_BYTES) throw new Error(`文件过大，无法进入沙箱：${path}`)
    total += size
    if (total > MAX_UPLOAD_BYTES) throw new Error("Workspace 源文件超过 50MB，无法进入沙箱")
    const data = readFileSync(checked.absolute!)
    const text = data.includes(0) ? null : data.toString("utf-8")
    if (text !== null && redactSensitive(text) !== text) {
      throw new Error(`检测到疑似密钥，文件不会上传到沙箱：${path}`)
    }
    files.push({ path: `${REMOTE_ROOT}/${path}`, data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) })
  }
  return files
}

async function uploadWorkspace(sandbox: Sandbox, userId: string, taskId: string) {
  await sandbox.commands.run(
    `mkdir -p ${REMOTE_ROOT} && find ${REMOTE_ROOT} -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf {} +`,
    { timeoutMs: 60_000 },
  )

  const files = localFiles(userId, taskId)
  for (let index = 0; index < files.length; index += BATCH_SIZE) {
    await sandbox.files.write(files.slice(index, index + BATCH_SIZE), { requestTimeoutMs: 120_000 })
  }

  await sandbox.commands.run([
    `cd ${REMOTE_ROOT}`,
    "git init -q",
    'git config user.name "mychat-agent"',
    'git config user.email "mychat-agent@users.noreply.github.com"',
    "git add -f -A -- . ':!node_modules' ':!.next' ':!dist' ':!build' ':!coverage' ':!.cache'",
    'git commit -qm "workspace baseline" --allow-empty',
  ].join(" && "), { timeoutMs: 120_000 })
}

async function changedPaths(sandbox: Sandbox): Promise<string[]> {
  const result = await sandbox.commands.run(
    "git diff HEAD --name-only -z && git ls-files --others --exclude-standard -z",
    { cwd: REMOTE_ROOT, timeoutMs: 30_000 },
  )
  return [...new Set(result.stdout.split("\0").filter(Boolean))]
}

async function syncWorkspace(
  sandbox: Sandbox,
  supabase: SupabaseClient,
  userId: string,
  taskId: string,
): Promise<string[]> {
  const paths = await changedPaths(sandbox)
  if (!paths.length) return []
  if (paths.length > MAX_SYNC_FILES) throw new Error(`命令改动了 ${paths.length} 个文件，超过同步上限`)

  const snapshot = await createWorkspaceSnapshot(taskId, userId, "auto: before isolated command sync", supabase)
  if (!snapshot.ok) throw new Error(`Snapshot 失败：${snapshot.error}`)

  const root = workspacePath(userId, taskId)
  const synced: string[] = []
  for (const path of paths) {
    const checked = validatePath(root, path)
    if (!checked.ok) continue
    const remotePath = `${REMOTE_ROOT}/${path}`
    const remoteExists = await sandbox.files.exists(remotePath)
    if (!remoteExists) {
      if (existsSync(checked.absolute!)) unlinkSync(checked.absolute!)
      synced.push(path)
      continue
    }

    const info = await sandbox.files.getInfo(remotePath)
    if (info.symlinkTarget || info.size > MAX_FILE_BYTES) continue
    const data = await sandbox.files.read(remotePath, { format: "bytes" })
    mkdirSync(dirname(checked.absolute!), { recursive: true })
    writeFileSync(checked.absolute!, data)
    chmodSync(checked.absolute!, info.mode & 0o777)
    synced.push(path)
  }

  if (synced.length) {
    await supabase
      .from("agent_workspaces")
      .update({ status: "dirty", updated_at: new Date().toISOString() })
      .eq("task_id", taskId)
      .eq("user_id", userId)
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
    const sandbox = await getSandbox(supabase, userId, taskId)
    await uploadWorkspace(sandbox, userId, taskId)

    let stdout = ""
    let stderr = ""
    let exitCode = 0
    let error = ""
    try {
      const result = await sandbox.commands.run(command, {
        cwd: opts.cwd ? `${REMOTE_ROOT}/${opts.cwd}` : REMOTE_ROOT,
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
    } catch (caught: any) {
      stdout = String(caught?.stdout ?? "")
      stderr = String(caught?.stderr ?? "")
      error = String(caught?.error ?? caught?.message ?? "命令执行失败")
      exitCode = Number.isInteger(caught?.exitCode) ? caught.exitCode : 1
    }

    const synced = await syncWorkspace(sandbox, supabase, userId, taskId)
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
  } catch (caught: any) {
    return {
      stdout: "",
      stderr: sanitizeCommandOutput(redactSensitive(String(caught?.message ?? caught))).slice(0, maxOutput),
      exitCode: 1,
      durationMs: Date.now() - startedAt,
      timedOut: false,
      blocked: false,
      backend: "isolated",
    }
  }
}
