import { execFileSync } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { createReadStream, existsSync, lstatSync, readlinkSync } from "node:fs"
import { resolve, sep } from "node:path"
import type { SupabaseClient } from "@/lib/supabase/types"

import { getChangedFiles, workspaceRoot } from "./workspace"

export const AGENT_CONFIRMATION_OPERATIONS = [
  "write_file",
  "edit_file",
  "delete_files",
  "apply_patch",
  "publish",
] as const

export type AgentConfirmationOperation = typeof AGENT_CONFIRMATION_OPERATIONS[number]

type CanonicalScalar = string | number | boolean | null
export type CanonicalValue = CanonicalScalar | CanonicalValue[] | { [key: string]: CanonicalValue }

export type AgentConfirmationCredential = {
  confirmationId: string
  confirmationToken: string
}

export type AgentOperationPlan = {
  version: 1
  userId: string
  taskId: string
  repo: string | null
  operation: AgentConfirmationOperation
  files: string[]
  baseBranch: string
  workspaceBranch: string | null
  head: string | null
  workspaceStateSha256: string
  payload: { [key: string]: CanonicalValue }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/

export function isAgentConfirmationOperation(value: unknown): value is AgentConfirmationOperation {
  return typeof value === "string"
    && (AGENT_CONFIRMATION_OPERATIONS as readonly string[]).includes(value)
}

function canonicalize(value: CanonicalValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`
}

export function canonicalAgentOperationPlan(plan: AgentOperationPlan): string {
  return canonicalize(plan)
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}

export function createAgentConfirmationToken(): { token: string; tokenSha256: string } {
  const token = randomBytes(32).toString("base64url")
  return { token, tokenSha256: sha256(token) }
}

export function parseAgentConfirmationCredential(
  input: Record<string, unknown>,
): AgentConfirmationCredential | null {
  const id = input.confirmationId
  const token = input.confirmationToken
  if (id === undefined && token === undefined) return null
  if (typeof id !== "string" || !UUID_PATTERN.test(id)
      || typeof token !== "string" || !TOKEN_PATTERN.test(token)) {
    throw new Error("confirmationId/confirmationToken 必须同时提供且格式有效")
  }
  return { confirmationId: id, confirmationToken: token }
}

function normalizeFiles(files: string[]): string[] {
  return [...new Set(files.map(file => file.normalize("NFC")))].sort()
}

async function hashFile(path: string, hash: ReturnType<typeof createHash>): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path)
    stream.on("data", chunk => hash.update(chunk))
    stream.on("error", reject)
    stream.on("end", resolvePromise)
  })
}

async function workspaceStateSha256(taskId: string, userId: string, files: string[]): Promise<string> {
  const root = workspaceRoot(taskId, userId)
  const rootPrefix = root.endsWith(sep) ? root : `${root}${sep}`
  const hash = createHash("sha256")
  const status = execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
    cwd: root,
    timeout: 10_000,
    maxBuffer: 4 * 1024 * 1024,
  })
  hash.update("git-status\0").update(status)

  for (const file of normalizeFiles(files)) {
    const absolute = resolve(root, file)
    if (absolute !== root && !absolute.startsWith(rootPrefix)) {
      throw new Error("确认计划包含越界文件")
    }
    hash.update("\0path\0").update(file).update("\0")
    if (!existsSync(absolute)) {
      hash.update("missing")
      continue
    }
    const stat = lstatSync(absolute)
    hash.update(`mode:${stat.mode};size:${stat.size};`)
    if (stat.isSymbolicLink()) {
      hash.update("symlink:").update(readlinkSync(absolute))
    } else if (stat.isFile()) {
      await hashFile(absolute, hash)
    } else {
      hash.update(`kind:${stat.isDirectory() ? "directory" : "other"}`)
    }
  }
  return hash.digest("hex")
}

export async function buildAgentOperationPlan(
  supabase: SupabaseClient,
  userId: string,
  taskId: string,
  operation: AgentConfirmationOperation,
  files: string[],
  payload: { [key: string]: CanonicalValue },
): Promise<AgentOperationPlan> {
  const { data: task, error } = await supabase
    .from("agent_tasks")
    .select("repo,branch")
    .eq("id", taskId)
    .eq("user_id", userId)
    .single()
  if (error || !task) throw new Error("任务不存在或无权访问")

  const root = workspaceRoot(taskId, userId)
  const changed = getChangedFiles(taskId, userId)
  if (!changed.ok) throw new Error(changed.error)
  const stateFiles = normalizeFiles([...changed.data.files.map(file => file.path), ...files])
  let workspaceBranch: string | null = null
  let head: string | null = null
  try {
    workspaceBranch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: root, timeout: 5000, encoding: "utf8",
    }).trim()
    head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root, timeout: 5000, encoding: "utf8",
    }).trim()
  } catch {
    throw new Error("无法绑定确认计划的 Git HEAD")
  }

  return {
    version: 1,
    userId,
    taskId,
    repo: typeof task.repo === "string" ? task.repo : null,
    operation,
    files: normalizeFiles(files),
    baseBranch: typeof task.branch === "string" ? task.branch : "main",
    workspaceBranch,
    head,
    workspaceStateSha256: await workspaceStateSha256(taskId, userId, stateFiles),
    payload,
  }
}
