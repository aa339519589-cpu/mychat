import type { SupabaseClient } from "@/lib/supabase/types"
import { errorMessage, isRecord } from "@/lib/unknown-value"

import { addArtifact, addStep, getTaskDetail, updateTaskStatus } from "../data"
import { redactSensitive } from "../path-security"
import { isProtectedBranch } from "../risk"
import type { AgentTaskDetail } from "../types"
import { workspaceRoot } from "../workspace"
import { checkRiskFiles, isValidGitHubRepository } from "./shared"
import { runGit } from "./git-command"
import type { PRResult } from "./types"

type ChangedFile = { path: string; status: string }
type PullRequestOptions = { title?: string; body?: string; base?: string; signal?: AbortSignal }
type PullRequestIdentity = { pullRequestUrl: string; pullRequestNumber: number }
type GitHubPullRequestResult =
  | ({ ok: true } & PullRequestIdentity)
  | { ok: false; error: string }

const MAX_BODY_LENGTH = 60_000
const MAX_CHANGED_FILES_IN_BODY = 200
const MAX_CHANGED_FILES_IN_ARTIFACT = 1_000

function throwIfAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted()
}

function requestSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(30_000)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

function parseNameStatus(output: string): ChangedFile[] {
  const fields = output.split("\0")
  const files: ChangedFile[] = []
  for (let index = 0; index < fields.length;) {
    const code = fields[index++] ?? ""
    if (!code) continue
    if (code.startsWith("R") || code.startsWith("C")) index++
    const path = fields[index++] ?? ""
    const status = code.startsWith("A")
      ? "added"
      : code.startsWith("D") ? "deleted" : "modified"
    if (path) files.push({ path, status })
  }
  return files
}

async function committedChanges(
  root: string,
  base: string,
  signal?: AbortSignal,
): Promise<{ changedFiles: ChangedFile[]; diff: string }> {
  try {
    const [nameStatus, diff] = await Promise.all([
      runGit(["diff", "--name-status", "-z", `${base}...HEAD`], {
        cwd: root, timeoutMs: 15_000, maxBuffer: 512 * 1024, signal,
      }),
      runGit(["diff", "--no-color", `${base}...HEAD`], {
        cwd: root, timeoutMs: 30_000, maxBuffer: 2 * 1024 * 1024, signal,
      }),
    ])
    return { changedFiles: parseNameStatus(nameStatus), diff }
  } catch {
    throwIfAborted(signal)
    const [nameStatus, diff] = await Promise.all([
      runGit(["diff", "--name-status", "-z", "HEAD"], {
        cwd: root, timeoutMs: 15_000, maxBuffer: 512 * 1024, signal,
      }).catch(() => ""),
      runGit(["diff", "--no-color", "HEAD"], {
        cwd: root, timeoutMs: 30_000, maxBuffer: 2 * 1024 * 1024, signal,
      }).catch(() => ""),
    ])
    throwIfAborted(signal)
    return { changedFiles: parseNameStatus(nameStatus), diff }
  }
}

async function resolveHeadBranch(
  root: string,
  persistedBranch: string | null,
  signal?: AbortSignal,
): Promise<{ ok: true; branch: string } | { ok: false; error: string }> {
  if (persistedBranch) return { ok: true, branch: persistedBranch }
  try {
    const branch = (await runGit(["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: root,
      timeoutMs: 5_000,
      signal,
    })).trim()
    return branch ? { ok: true, branch } : { ok: false, error: "无法确定 head branch" }
  } catch {
    throwIfAborted(signal)
    return { ok: false, error: "无法确定 head branch" }
  }
}

async function isValidBranch(root: string, branch: string, signal?: AbortSignal): Promise<boolean> {
  if (!branch || Buffer.byteLength(branch, "utf8") > 255) return false
  try {
    await runGit(["check-ref-format", "--branch", branch], {
      cwd: root,
      timeoutMs: 5_000,
      signal,
    })
    return true
  } catch {
    throwIfAborted(signal)
    return false
  }
}

function inlineCode(value: string): string {
  const safe = value.replace(/[\0-\x1f\x7f]/g, " ").replace(/`/g, "'").trim()
  return `\`${safe}\``
}

function changeMarker(status: string): string {
  if (status === "added") return "A"
  if (status === "modified") return "M"
  if (status === "deleted") return "D"
  return "?"
}

function changedFileList(changedFiles: ChangedFile[]): string {
  const visible = changedFiles.slice(0, MAX_CHANGED_FILES_IN_BODY)
  const lines = visible.map(file => `- ${changeMarker(file.status)} ${inlineCode(file.path)}`)
  if (changedFiles.length > visible.length) {
    lines.push(`- ... ${changedFiles.length - visible.length} more files omitted`)
  }
  return lines.join("\n") || "（无文件变更）"
}

function verificationNote(artifacts: AgentTaskDetail["artifacts"]): string {
  const latest = new Map<string, boolean>()
  for (const artifact of [...artifacts].sort((left, right) => (
    right.createdAt.localeCompare(left.createdAt)
  ))) {
    const name = typeof artifact.meta?.name === "string" ? artifact.meta.name : null
    if (name && typeof artifact.meta?.passed === "boolean" && !latest.has(name)) {
      latest.set(name, artifact.meta.passed)
    }
  }
  if (!latest.size) return "- 未运行自动测试（仅完成静态 diff 核对）"
  return [...latest]
    .map(([name, passed]) => `- ${inlineCode(name)}: **${passed ? "通过" : "失败"}**`)
    .join("\n")
}

function warningNote(files: string[]): string {
  if (!files.length) return ""
  return [
    "",
    "## 需要复核的高风险文件",
    ...files.slice(0, MAX_CHANGED_FILES_IN_BODY).map(file => `- ${inlineCode(file)}`),
  ].join("\n")
}

function defaultPullRequestBody(
  detail: AgentTaskDetail,
  changedFiles: ChangedFile[],
  diff: string,
  warnings: string[],
): string {
  return [
    "## 任务目标",
    redactSensitive(detail.goal).slice(0, 2_000),
    "",
    "## 改动文件",
    changedFileList(changedFiles),
    "",
    "## 变更摘要",
    "```diff",
    redactSensitive(diff).slice(0, 3_000),
    "```",
    warningNote(warnings),
    "",
    "## 验证状态",
    verificationNote(detail.artifacts),
    "",
    "## 备注",
    "- 回滚说明：本地 workspace 有 snapshot，可回滚",
    "- 由 MyChat Agent 创建",
  ].join("\n").slice(0, MAX_BODY_LENGTH)
}

function pullRequestTitle(customTitle: string | undefined, goal: string): string {
  const fallback = `Agent: ${goal.slice(0, 60)}`
  const title = customTitle?.trim() || fallback
  return redactSensitive(title.replace(/[\0\r\n]/g, " ")).slice(0, 256)
}

function pullRequestBody(
  customBody: string | undefined,
  detail: AgentTaskDetail,
  changedFiles: ChangedFile[],
  diff: string,
  warnings: string[],
): string {
  if (!customBody) return defaultPullRequestBody(detail, changedFiles, diff, warnings)
  return redactSensitive(customBody).slice(0, MAX_BODY_LENGTH)
}

function githubHeaders(githubToken: string, includeContentType = false): HeadersInit {
  return {
    Authorization: `Bearer ${githubToken}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "mychat-agent",
    ...(includeContentType ? { "Content-Type": "application/json" } : {}),
  }
}

function parsePullRequest(value: unknown, repo: string): PullRequestIdentity | null {
  if (!isRecord(value) || typeof value.html_url !== "string") return null
  if (!Number.isSafeInteger(value.number) || (value.number as number) < 1) return null
  const pullRequestNumber = value.number as number
  try {
    const url = new URL(value.html_url)
    const expectedPath = `/${repo}/pull/${pullRequestNumber}`.toLowerCase()
    const actualPath = url.pathname.replace(/\/$/, "").toLowerCase()
    if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port
      || url.username || url.password || url.search || url.hash || actualPath !== expectedPath) return null
    return { pullRequestUrl: url.toString(), pullRequestNumber }
  } catch {
    return null
  }
}

async function responsePullRequest(response: Response, repo: string): Promise<PullRequestIdentity | null> {
  const payload = await response.json().catch(() => null)
  return parsePullRequest(payload, repo)
}

async function existingPullRequest(
  repo: string,
  headBranch: string,
  base: string,
  githubToken: string,
  signal?: AbortSignal,
): Promise<PullRequestIdentity | null> {
  const owner = repo.split("/")[0] ?? ""
  const query = new URLSearchParams({ state: "open", head: `${owner}:${headBranch}`, base })
  const response = await fetch(`https://api.github.com/repos/${repo}/pulls?${query}`, {
    headers: githubHeaders(githubToken),
    signal: requestSignal(signal),
  })
  if (!response.ok) return null
  const payload = await response.json().catch(() => null)
  if (!Array.isArray(payload)) return null
  for (const candidate of payload) {
    const parsed = parsePullRequest(candidate, repo)
    if (parsed) return parsed
  }
  return null
}

async function githubFailure(response: Response): Promise<string> {
  const payload = await response.json().catch(() => null)
  const message = isRecord(payload) && typeof payload.message === "string"
    ? payload.message
    : `HTTP ${response.status}`
  return redactSensitive(message).slice(0, 500)
}

async function requestPullRequest(input: {
  repo: string
  headBranch: string
  base: string
  title: string
  body: string
  githubToken: string
  signal?: AbortSignal
}): Promise<GitHubPullRequestResult> {
  try {
    const response = await fetch(`https://api.github.com/repos/${input.repo}/pulls`, {
      method: "POST",
      headers: githubHeaders(input.githubToken, true),
      body: JSON.stringify({ title: input.title, body: input.body, head: input.headBranch, base: input.base }),
      signal: requestSignal(input.signal),
    })
    if (response.ok) {
      const created = await responsePullRequest(response, input.repo)
      return created
        ? { ok: true, ...created }
        : { ok: false, error: "创建 PR 成功但未获取到 URL（响应无效）" }
    }
    if (response.status === 422) {
      const existing = await existingPullRequest(
        input.repo, input.headBranch, input.base, input.githubToken, input.signal,
      )
      if (existing) return { ok: true, ...existing }
    }
    return { ok: false, error: `创建 PR 失败：${await githubFailure(response)}` }
  } catch (error) {
    throwIfAborted(input.signal)
    const message = redactSensitive(errorMessage(error, "网络错误")).slice(0, 500)
    return { ok: false, error: `创建 PR 失败：${message}` }
  }
}

async function recordPullRequest(
  supabase: SupabaseClient,
  userId: string,
  taskId: string,
  detail: AgentTaskDetail,
  identity: PullRequestIdentity,
  title: string,
  headBranch: string,
  base: string,
  changedFiles: ChangedFile[],
): Promise<void> {
  await updateTaskStatus(supabase, userId, taskId, "completed", {
    finishedAt: new Date().toISOString(),
    pullRequestUrl: identity.pullRequestUrl,
    pullRequestNumber: identity.pullRequestNumber,
    agentBranch: headBranch,
    commitSha: detail.commitSha ?? undefined,
  })
  await addArtifact(supabase, userId, {
    taskId,
    kind: "pr_link",
    title: `PR: ${title.slice(0, 60)}`,
    url: identity.pullRequestUrl,
    content: `Pull Request: ${identity.pullRequestUrl}\nBranch: ${headBranch} → ${base}\nFiles: ${changedFiles.length}`,
    meta: {
      prUrl: identity.pullRequestUrl,
      prNumber: identity.pullRequestNumber,
      headBranch,
      base,
      changedFiles: changedFiles.slice(0, MAX_CHANGED_FILES_IN_ARTIFACT).map(file => file.path),
      changedFileCount: changedFiles.length,
      commitSha: detail.commitSha,
    },
  })
}

export async function createWorkspacePullRequest(
  taskId: string,
  userId: string,
  githubToken: string,
  supabase: SupabaseClient,
  options: PullRequestOptions = {},
): Promise<PRResult> {
  const detail = await getTaskDetail(supabase, userId, taskId)
  if (!("workspace" in detail)) return { ok: false, error: "任务不存在" }
  const repo = detail.repo
  if (!repo) return { ok: false, error: "任务未关联仓库" }
  if (!isValidGitHubRepository(repo)) return { ok: false, error: "任务关联的 GitHub 仓库格式无效" }

  const root = workspaceRoot(taskId, userId)
  const head = await resolveHeadBranch(root, detail.agentBranch, options.signal)
  if (!head.ok) return head
  if (isProtectedBranch(head.branch)) return { ok: false, error: `禁止从 ${head.branch} 创建 PR` }

  const base = options.base || detail.branch || "main"
  const branchesValid = await Promise.all([
    isValidBranch(root, head.branch, options.signal),
    isValidBranch(root, base, options.signal),
  ])
  if (branchesValid.some(valid => !valid)) return { ok: false, error: "Pull Request 分支格式无效" }

  const { changedFiles, diff } = await committedChanges(root, base, options.signal)
  const risk = checkRiskFiles(changedFiles.map(file => file.path))
  if (risk.blocked.length) return { ok: false, error: `Pull Request 包含禁止发布的高危文件：${risk.blocked.join("、")}` }
  const title = pullRequestTitle(options.title, detail.goal)
  const body = pullRequestBody(options.body, detail, changedFiles, diff, risk.warnings)

  await addStep(supabase, userId, taskId, {
    kind: "tool_call",
    label: "创建 Pull Request",
    detail: `${head.branch} → ${base}`,
  })

  const created = await requestPullRequest({
    repo,
    headBranch: head.branch,
    base,
    title,
    body,
    githubToken,
    signal: options.signal,
  })
  if (!created.ok) return created

  await recordPullRequest(
    supabase, userId, taskId, detail, created, title, head.branch, base, changedFiles,
  )

  return {
    ok: true,
    pullRequestUrl: created.pullRequestUrl,
    pullRequestNumber: created.pullRequestNumber,
    title,
    head: head.branch,
    base,
  }
}
