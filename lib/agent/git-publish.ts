// Git Publish 模块：workspace 改动 → agent branch → commit → push → PR
// 安全原则：禁止推 main，禁止 force push，禁止 token 泄露

import { existsSync, readFileSync } from "fs"
import { execSync } from "child_process"
import type { SupabaseClient } from "@supabase/supabase-js"
import { workspaceRoot, getChangedFiles, getWorkspaceDiff } from "./workspace"
import { getTaskDetail, getWorkspaceByTaskId, updateTaskStatus, addStep, addArtifact } from "./data"
import { redactSensitive } from "./path-security"

// ───────────── 类型 ─────────────

export type GitStatus = {
  ok: boolean
  error?: string
  currentBranch?: string
  changedFiles?: { path: string; status: string }[]
  diffStat?: string
  diffPreview?: string
  hasChanges?: boolean
  commitSha?: string | null
}

export type CommitResult = {
  ok: boolean
  error?: string
  commitSha?: string
  message?: string
  changedFiles?: string[]
  diffStat?: string
}

export type PushResult = {
  ok: boolean
  error?: string
  branch?: string
  remote?: string
}

export type PRResult = {
  ok: boolean
  error?: string
  pullRequestUrl?: string
  pullRequestNumber?: number
  title?: string
  head?: string
  base?: string
}

export type PublishResult = {
  ok: boolean
  error?: string
  stage?: string
  status?: GitStatus
  commit?: CommitResult
  push?: PushResult
  pr?: PRResult
}

// ───────────── 内部工具 ─────────────

function sanitizeBranchName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\-_]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60)
}

const FORBIDDEN_BRANCHES = ["main", "master", "production", "prod", "release"]

function isForbiddenBranch(branch: string): boolean {
  return FORBIDDEN_BRANCHES.includes(branch.toLowerCase().trim())
}

const HIGH_RISK_PATTERNS = [
  /\.env(\..*)?$/,
  /\.pem$/,
  /\.key$/,
  /\.pfx$/,
  /\.p12$/,
  /\.jks$/,
  /\.keystore$/,
  /credentials/i,
  /private.?key/i,
]

const MEDIUM_RISK_PATTERNS = [
  /^\.github\/workflows\//,
  /^supabase\/migrations\//,
  /package-lock\.json$/,
  /pnpm-lock\.yaml$/,
  /yarn\.lock$/,
  /auth\//i,
  /payment/i,
]

const AGENT_GIT_NAME = "mychat-agent"
const AGENT_GIT_EMAIL = "mychat-agent@users.noreply.github.com"

function checkRiskFiles(files: string[]): { blocked: string[]; warnings: string[] } {
  const blocked: string[] = []
  const warnings: string[] = []
  for (const f of files) {
    if (HIGH_RISK_PATTERNS.some(p => p.test(f))) {
      blocked.push(f)
    } else if (MEDIUM_RISK_PATTERNS.some(p => p.test(f))) {
      warnings.push(f)
    }
  }
  return { blocked, warnings }
}

function gitCommitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: AGENT_GIT_NAME,
    GIT_AUTHOR_EMAIL: AGENT_GIT_EMAIL,
    GIT_COMMITTER_NAME: AGENT_GIT_NAME,
    GIT_COMMITTER_EMAIL: AGENT_GIT_EMAIL,
  }
}

function ensureWorkspaceGitIdentity(root: string): NodeJS.ProcessEnv {
  const env = gitCommitEnv()
  execSync(`git config user.name "${AGENT_GIT_NAME}"`, {
    cwd: root, timeout: 5000, encoding: "utf-8", env,
  })
  execSync(`git config user.email "${AGENT_GIT_EMAIL}"`, {
    cwd: root, timeout: 5000, encoding: "utf-8", env,
  })
  return env
}

// ───────────── 公开 API ─────────────

// 1. Git Status
export function getWorkspaceGitStatus(taskId: string, userId: string): GitStatus {
  const root = workspaceRoot(taskId, userId)
  if (!existsSync(root)) return { ok: false, error: "Workspace 不存在" }

  let currentBranch = ""
  try {
    currentBranch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: root, timeout: 5000, encoding: "utf-8",
    }).trim()
  } catch {
    return { ok: false, error: "无法获取当前分支" }
  }

  const changed = getChangedFiles(taskId, userId)
  const changedFiles = changed.ok ? changed.data.files : []

  let diffStat = ""
  let diffPreview = ""
  let hasChanges = false
  try {
    diffStat = execSync("git diff --stat", {
      cwd: root, timeout: 10000, maxBuffer: 256 * 1024, encoding: "utf-8",
    })
    diffPreview = execSync("git diff --name-only", {
      cwd: root, timeout: 10000, maxBuffer: 256 * 1024, encoding: "utf-8",
    })
    hasChanges = diffPreview.trim().length > 0
  } catch { /* no changes */ }

  // 也检查未跟踪文件
  try {
    const untracked = execSync("git ls-files --others --exclude-standard", {
      cwd: root, timeout: 5000, maxBuffer: 64 * 1024, encoding: "utf-8",
    }).trim()
    if (untracked) hasChanges = true
  } catch {}

  let commitSha: string | null = null
  try {
    commitSha = execSync("git rev-parse HEAD", {
      cwd: root, timeout: 5000, encoding: "utf-8",
    }).trim()
  } catch {}

  return {
    ok: true,
    currentBranch,
    changedFiles,
    diffStat: redactSensitive(diffStat),
    diffPreview: redactSensitive(diffPreview),
    hasChanges,
    commitSha,
  }
}

// 2. Commit
export async function commitWorkspaceChanges(
  taskId: string,
  userId: string,
  message: string,
  supabase: SupabaseClient,
): Promise<CommitResult> {
  const root = workspaceRoot(taskId, userId)
  if (!existsSync(root)) return { ok: false, error: "Workspace 不存在" }

  // 检查 task 归属
  const detail = await getTaskDetail(supabase, userId, taskId)
  if (!("workspace" in detail)) return { ok: false, error: "任务不存在或无权访问" }

  // 检查当前分支
  let currentBranch = ""
  try {
    currentBranch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: root, timeout: 5000, encoding: "utf-8",
    }).trim()
  } catch {
    return { ok: false, error: "无法获取当前分支" }
  }

  if (isForbiddenBranch(currentBranch)) {
    return { ok: false, error: `禁止在 ${currentBranch} 分支上 commit，请先切换到 agent branch` }
  }

  // 检查是否有改动
  let hasChanges = false
  try {
    const stat = execSync("git status --porcelain", {
      cwd: root, timeout: 5000, maxBuffer: 64 * 1024, encoding: "utf-8",
    })
    hasChanges = stat.trim().length > 0
  } catch {}

  if (!hasChanges) {
    return { ok: false, error: "没有可提交的改动" }
  }

  // 获取 changed files
  let changedFiles: string[] = []
  try {
    changedFiles = execSync("git diff --name-only HEAD", {
      cwd: root, timeout: 10000, maxBuffer: 128 * 1024, encoding: "utf-8",
    }).trim().split("\n").filter(Boolean)
    // 追加未跟踪文件
    const untracked = execSync("git ls-files --others --exclude-standard", {
      cwd: root, timeout: 5000, maxBuffer: 64 * 1024, encoding: "utf-8",
    }).trim()
    if (untracked) changedFiles.push(...untracked.split("\n").filter(Boolean))
  } catch {}

  // 风险检查
  const { blocked } = checkRiskFiles(changedFiles)
  if (blocked.length > 0) {
    return { ok: false, error: `禁止提交高危文件：${blocked.join("、")}` }
  }

  // 写入 step
  await addStep(supabase, userId, taskId, {
    kind: "tool_call",
    label: "git commit",
    detail: `${changedFiles.length} 个文件`,
  })

  // 获取 diff stat
  let diffStat = ""
  try { diffStat = execSync("git diff --stat HEAD", { cwd: root, timeout: 10000, maxBuffer: 128 * 1024, encoding: "utf-8" }) } catch {}

  // 截断 message
  const safeMessage = message.slice(0, 200) || "Agent: code changes"

  // 执行 commit
  try {
    const commitEnv = ensureWorkspaceGitIdentity(root)
    // git add all
    execSync("git add -A", {
      cwd: root, timeout: 15000, maxBuffer: 256 * 1024, encoding: "utf-8", env: commitEnv,
    })
    // 再次确认没有高危文件被 staged
    let stagedFiles: string[] = []
    try {
      stagedFiles = execSync("git diff --cached --name-only", {
        cwd: root, timeout: 10000, maxBuffer: 128 * 1024, encoding: "utf-8", env: commitEnv,
      }).trim().split("\n").filter(Boolean)
    } catch {}
    const { blocked: stageBlocked } = checkRiskFiles(stagedFiles)
    if (stageBlocked.length > 0) {
      // unstage and abort
      execSync("git reset HEAD -- .", { cwd: root, timeout: 10000, encoding: "utf-8", env: commitEnv })
      return { ok: false, error: `禁止提交高危文件：${stageBlocked.join("、")}` }
    }

    execSync(`git commit -m "${safeMessage.replace(/"/g, '\\"')}"`, {
      cwd: root, timeout: 30000, maxBuffer: 256 * 1024, encoding: "utf-8", env: commitEnv,
    })
  } catch (err: any) {
    const stderr = err?.stderr ?? err?.message ?? ""
    return { ok: false, error: `Commit 失败：${stderr}` }
  }

  // 获取 commitSha
  let commitSha = ""
  try {
    commitSha = execSync("git rev-parse HEAD", {
      cwd: root, timeout: 5000, encoding: "utf-8",
    }).trim()
  } catch {}

  // 写 artifact
  await addArtifact(supabase, userId, {
    taskId,
    kind: "diff",
    title: `Commit: ${safeMessage.slice(0, 50)}`,
    content: redactSensitive(diffStat).slice(0, 10000),
    meta: {
      commitSha,
      branch: currentBranch,
      changedFiles,
      diffStat: redactSensitive(diffStat).slice(0, 2000),
    },
  })

  // 更新 task commitSha
  await updateTaskStatus(supabase, userId, taskId, detail.status, {
    commitSha,
    agentBranch: currentBranch,
  })

  return {
    ok: true,
    commitSha,
    message: safeMessage,
    changedFiles,
    diffStat: redactSensitive(diffStat),
  }
}

// 3. Push agent branch
export async function pushAgentBranch(
  taskId: string,
  userId: string,
  githubToken: string,
  supabase: SupabaseClient,
): Promise<PushResult> {
  const root = workspaceRoot(taskId, userId)
  if (!existsSync(root)) return { ok: false, error: "Workspace 不存在" }

  let currentBranch = ""
  try {
    currentBranch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: root, timeout: 5000, encoding: "utf-8",
    }).trim()
  } catch {
    return { ok: false, error: "无法获取当前分支" }
  }

  if (isForbiddenBranch(currentBranch)) {
    return { ok: false, error: `禁止推送 ${currentBranch} 分支` }
  }

  // 获取 remote 信息（从 workspace repo 推断）
  const detail = await getTaskDetail(supabase, userId, taskId)
  if (!("workspace" in detail)) return { ok: false, error: "任务不存在" }
  const repo = detail.repo
  if (!repo) return { ok: false, error: "任务未关联仓库" }

  // 检查 remote
  let remoteName = "origin"
  try {
    const remotes = execSync("git remote", { cwd: root, timeout: 5000, encoding: "utf-8" }).trim()
    if (!remotes) {
      // 添加 remote
      const remoteUrl = `https://x-access-token:${githubToken}@github.com/${repo}.git`
      try {
        execSync(`git remote add origin "${remoteUrl}"`, { cwd: root, timeout: 10000, encoding: "utf-8" })
      } catch {
        // 可能已经存在但 URL 不对，更新
        try { execSync(`git remote set-url origin "${remoteUrl}"`, { cwd: root, timeout: 10000, encoding: "utf-8" }) } catch {}
      }
    }
  } catch {
    // 添加 remote
    const remoteUrl = `https://x-access-token:${githubToken}@github.com/${repo}.git`
    try { execSync(`git remote add origin "${remoteUrl}"`, { cwd: root, timeout: 10000, encoding: "utf-8" }) } catch {}
  }

  // 写入 step
  await addStep(supabase, userId, taskId, {
    kind: "tool_call",
    label: `git push ${currentBranch}`,
    detail: `推送到 ${repo}`,
  })

  // 执行 push（不 force）
  try {
    execSync(`git push origin "${currentBranch}"`, {
      cwd: root, timeout: 120_000, maxBuffer: 512 * 1024, encoding: "utf-8",
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "echo",
      },
    })
  } catch (err: any) {
    const stderr = err?.stderr ?? err?.message ?? ""
    return { ok: false, error: `Push 失败：${stderr.replace(githubToken, "***")}` }
  }

  return {
    ok: true,
    branch: currentBranch,
    remote: repo,
  }
}

// 4. Create Pull Request
export async function createWorkspacePullRequest(
  taskId: string,
  userId: string,
  githubToken: string,
  supabase: SupabaseClient,
  options: { title?: string; body?: string; base?: string } = {},
): Promise<PRResult> {
  const detail = await getTaskDetail(supabase, userId, taskId)
  if (!("workspace" in detail)) return { ok: false, error: "任务不存在" }

  const repo = detail.repo
  if (!repo) return { ok: false, error: "任务未关联仓库" }

  const root = workspaceRoot(taskId, userId)
  let headBranch = detail.agentBranch
  if (!headBranch) {
    try {
      headBranch = execSync("git rev-parse --abbrev-ref HEAD", {
        cwd: root, timeout: 5000, encoding: "utf-8",
      }).trim()
    } catch {
      return { ok: false, error: "无法确定 head branch" }
    }
  }

  if (isForbiddenBranch(headBranch)) {
    return { ok: false, error: `禁止从 ${headBranch} 创建 PR` }
  }

  const base = options.base || detail.branch || "main"

  // 获取 changed files 和 diff
  const changed = getChangedFiles(taskId, userId)
  const changedFiles = changed.ok ? changed.data.files : []
  const diff = getWorkspaceDiff(taskId, userId)

  // 构建 PR title
  const title = options.title || `Agent: ${detail.goal.slice(0, 60)}`

  // 构建 PR body
  const risk = checkRiskFiles(changedFiles.map(f => f.path))
  const fileList = changedFiles.map(f => `- ${f.status === "added" ? "A" : f.status === "modified" ? "M" : f.status === "deleted" ? "D" : "?"} \`${f.path}\``).join("\n")
  const riskNote = risk.blocked.length > 0 ? `\n### ⚠️ 高危文件已拦截\n${risk.blocked.map(f => `- ${f}`).join("\n")}\n` : ""
  const warnNote = risk.warnings.length > 0 ? `\n### ⚡ 中风险文件\n${risk.warnings.map(f => `- ${f}`).join("\n")}\n` : ""

  const body = options.body || [
    `## 任务目标`,
    detail.goal,
    "",
    "## 改动文件",
    fileList || "（无文件变更）",
    "",
    "## 变更摘要",
    "```",
    redactSensitive(diff).slice(0, 3000),
    "```",
    "",
    riskNote,
    warnNote,
    "## 备注",
    "- 测试状态：**本阶段未运行 build/test**",
    "- 回滚说明：本地 workspace 有 snapshot，可回滚",
    "- 由 mychat Agent 创建",
    "",
    `🤖 Generated with [Claude Code](https://claude.com/claude-code)`,
  ].join("\n")

  // 写入 step
  await addStep(supabase, userId, taskId, {
    kind: "tool_call",
    label: "创建 Pull Request",
    detail: `${headBranch} → ${base}`,
  })

  // 调用 GitHub API
  let prUrl = ""
  let prNumber: number | null = null
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/pulls`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${githubToken}`,
        "Content-Type": "application/json",
        Accept: "application/vnd.github+json",
        "User-Agent": "mychat-agent",
      },
      body: JSON.stringify({
        title,
        body,
        head: headBranch,
        base,
      }),
    })

    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      const msg = (err as any)?.message ?? `HTTP ${res.status}`
      return { ok: false, error: `创建 PR 失败：${msg}` }
    }

    const pr = await res.json()
    prUrl = (pr as any).html_url ?? ""
    prNumber = (pr as any).number ?? null
  } catch (err: any) {
    return { ok: false, error: `创建 PR 失败：${err?.message ?? "网络错误"}` }
  }

  if (!prUrl) {
    return { ok: false, error: "创建 PR 成功但未获取到 URL" }
  }

  // 更新 task
  await updateTaskStatus(supabase, userId, taskId, "completed", {
    finishedAt: new Date().toISOString(),
    pullRequestUrl: prUrl,
    pullRequestNumber: prNumber ?? undefined,
    agentBranch: headBranch,
    commitSha: detail.commitSha ?? undefined,
  })

  // 写入 artifact
  await addArtifact(supabase, userId, {
    taskId,
    kind: "pr_link",
    title: `PR: ${title.slice(0, 60)}`,
    url: prUrl,
    content: `Pull Request: ${prUrl}\nBranch: ${headBranch} → ${base}\nFiles: ${changedFiles.length}`,
    meta: {
      prUrl,
      prNumber,
      headBranch,
      base,
      changedFiles: changedFiles.map(f => f.path),
      commitSha: detail.commitSha,
    },
  })

  return {
    ok: true,
    pullRequestUrl: prUrl,
    pullRequestNumber: prNumber ?? undefined,
    title,
    head: headBranch,
    base,
  }
}

// 5. 一键 Publish（commit → push → PR）
export async function publishWorkspaceToPullRequest(
  taskId: string,
  userId: string,
  githubToken: string,
  supabase: SupabaseClient,
  options: { message?: string; title?: string; body?: string; base?: string } = {},
): Promise<PublishResult> {
  // Step 1: 检查 status
  const status = getWorkspaceGitStatus(taskId, userId)
  if (!status.ok) return { ok: false, error: status.error, stage: "status" }
  if (!status.hasChanges) return { ok: false, error: "没有可提交的改动", stage: "status", status }

  await addStep(supabase, userId, taskId, {
    kind: "info",
    label: "开始发布",
    detail: `${status.changedFiles?.length ?? 0} 个待提交文件`,
  })

  // Update status to creating_pr
  await updateTaskStatus(supabase, userId, taskId, "creating_pr")

  // Step 2: Commit
  const taskDetail = await getTaskDetail(supabase, userId, taskId)
  const goal = ("workspace" in taskDetail) ? taskDetail.goal : ""
  const msg = options.message || `Agent: ${goal.slice(0, 60) || "code changes"}`

  const commit = await commitWorkspaceChanges(taskId, userId, msg, supabase)
  if (!commit.ok) {
    await updateTaskStatus(supabase, userId, taskId, "failed", { error: commit.error })
    return { ok: false, error: commit.error, stage: "commit", status, commit }
  }

  // Step 3: Push
  const push = await pushAgentBranch(taskId, userId, githubToken, supabase)
  if (!push.ok) {
    await updateTaskStatus(supabase, userId, taskId, "failed", { error: push.error })
    return { ok: false, error: push.error, stage: "push", status, commit, push }
  }

  // Step 4: Create PR
  const pr = await createWorkspacePullRequest(taskId, userId, githubToken, supabase, {
    title: options.title,
    body: options.body,
    base: options.base,
  })
  if (!pr.ok) {
    await updateTaskStatus(supabase, userId, taskId, "failed", { error: pr.error })
    return { ok: false, error: pr.error, stage: "pr", status, commit, push, pr }
  }

  console.warn(`Publish complete: ${pr.pullRequestUrl}`)

  return { ok: true, status, commit, push, pr }
}
