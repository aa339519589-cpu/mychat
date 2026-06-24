import { createHash } from "crypto"
import { execFileSync, execSync } from "child_process"
import { gzipSync, gunzipSync } from "zlib"
import type { SupabaseClient } from "@supabase/supabase-js"
import { workspacePath } from "./workspace"
import { redactSensitive } from "./path-security"

const TITLE = "workspace-checkpoint"
const MAX_DIFF_BYTES = 2 * 1024 * 1024
const MAX_COMPRESSED_BYTES = 1024 * 1024

export type CheckpointResult = { ok: true; restored?: boolean; empty?: boolean } | { ok: false; error: string }

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function checkpointDiff(userId: string, taskId: string): string {
  const root = workspacePath(userId, taskId)
  let diff = execFileSync("git", ["diff", "--binary", "--no-color", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: MAX_DIFF_BYTES,
  })
  const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 512 * 1024,
  }).split("\0").filter(Boolean)
  for (const path of untracked) {
    try {
      execFileSync("git", ["diff", "--binary", "--no-index", "--", "/dev/null", path], {
        cwd: root,
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: MAX_DIFF_BYTES,
      })
    } catch (caught: any) {
      if (caught?.status !== 1 || typeof caught?.stdout !== "string") throw caught
      diff += `${diff ? "\n" : ""}${caught.stdout}`
    }
  }
  return diff
}

export async function saveWorkspaceCheckpoint(
  supabase: SupabaseClient,
  userId: string,
  taskId: string,
): Promise<CheckpointResult> {
  let diff = ""
  try { diff = checkpointDiff(userId, taskId) } catch { return { ok: false, error: "生成后台检查点失败" } }
  if (!diff.trim()) return { ok: true, empty: true }
  if (Buffer.byteLength(diff) >= MAX_DIFF_BYTES) return { ok: false, error: "改动超过 2MB，无法保存后台检查点" }
  if (redactSensitive(diff) !== diff) return { ok: false, error: "改动疑似包含密钥，拒绝保存后台检查点" }

  const compressed = gzipSync(Buffer.from(diff, "utf8"))
  if (compressed.byteLength > MAX_COMPRESSED_BYTES) return { ok: false, error: "压缩后的检查点超过 1MB" }

  const id = crypto.randomUUID()
  const { error } = await supabase.from("agent_artifacts").insert({
    id,
    task_id: taskId,
    user_id: userId,
    kind: "summary",
    title: TITLE,
    content: compressed.toString("base64"),
    meta: { encoding: "gzip-base64", sha256: digest(diff), bytes: Buffer.byteLength(diff) },
  })
  if (error) return { ok: false, error: error.message }

  await supabase
    .from("agent_artifacts")
    .delete()
    .eq("task_id", taskId)
    .eq("user_id", userId)
    .eq("title", TITLE)
    .neq("id", id)
  return { ok: true }
}

export async function restoreLatestWorkspaceCheckpoint(
  supabase: SupabaseClient,
  userId: string,
  taskId: string,
): Promise<CheckpointResult> {
  const { data, error } = await supabase
    .from("agent_artifacts")
    .select("content, meta")
    .eq("task_id", taskId)
    .eq("user_id", userId)
    .eq("title", TITLE)
    .order("created_at", { ascending: false })
    .limit(1)
  if (error) return { ok: false, error: error.message }
  if (!data?.length) return { ok: true, empty: true }

  try {
    const diff = gunzipSync(Buffer.from(data[0].content ?? "", "base64")).toString("utf8")
    const expected = data[0].meta?.sha256
    if (expected && digest(diff) !== expected) return { ok: false, error: "后台检查点校验失败" }
    execSync("git apply --binary --whitespace=nowarn", {
      cwd: workspacePath(userId, taskId),
      input: diff,
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
    })
    return { ok: true, restored: true }
  } catch (caught: any) {
    return { ok: false, error: caught?.stderr?.toString() || caught?.message || "恢复后台检查点失败" }
  }
}
