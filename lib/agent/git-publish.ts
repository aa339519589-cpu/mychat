// Git Publish 模块：workspace 改动 → agent branch → commit → push → PR
// 安全原则：禁止推 main，禁止 force push，禁止 token 泄露

import { existsSync } from "fs"
import { execFileSync, execSync } from "child_process"
import type { SupabaseClient } from "@supabase/supabase-js"
import { workspaceRoot, getChangedFiles, getWorkspaceDiff } from "./workspace"
import { getTaskDetail, updateTaskStatus, addStep, addArtifact } from "./data"
import { redactSensitive } from "./path-security"
import { classifyFileRisk, isProtectedBranch } from "./risk"

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

const AGENT_GIT_NAME = "mychat-agent"
const AGENT_GIT_EMAIL = "mychat-agent@users.noreply.github.com"

function checkRiskFiles(files: string[]): { blocked: string[]; warnings: string[] } {
  const risk = classifyFileRisk(files)
  return {
    blocked: risk.blocked ? risk.files : [],
    warnings: risk.needsConfirmation ? risk.files : [],
  }
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

function gitAuthEnv(token: string): NodeJS.ProcessEnv {
  const credentials = Buffer.from(`x-access-token:${token}`).toString("base64")
  return {
    ...gitCommitEnv(),
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "echo",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${credentials}`,
  }
}

function ensureWorkspaceGitIdentity(root: string): NodeJS.ProcessEnv {
  const env = gitCommitEnv()
  execFileSync("git", ["config", "user.name", AGENT_GIT_NAME], {
    cwd: root, timeout: 5000, encoding: "utf-8", env,
  })
  execFileSync("git", ["config", "user.email", AGENT_GIT_EMAIL], {
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

  if (isProtectedBranch(currentBranch)) {
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
    execFileSync("git", ["add", "-A", "--", ".", ":(exclude).claude/snapshots/**"], {
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
      execFileSync("git", ["reset", "HEAD", "--", "."], { cwd: root, timeout: 10000, encoding: "utf-8", env: commitEnv })
      return { ok: false, error: `禁止提交高危文件：${stageBlocked.join("、")}` }
    }

    execFileSync("git", ["commit", "-m", safeMessage], {
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

  if (isProtectedBranch(currentBranch)) {
    return { ok: false, error: `禁止推送 ${currentBranch} 分支` }
  }

  // 获取 remote 信息（从 workspace repo 推断）
  const detail = await getTaskDetail(supabase, userId, taskId)
  if (!("workspace" in detail)) return { ok: false, error: "任务不存在" }
  const repo = detail.repo
  if (!repo) return { ok: false, error: "任务未关联仓库" }

  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    return { ok: false, error: "任务关联的 GitHub 仓库格式无效" }
  }

  // Remote 永远保存无凭据 URL；认证仅通过子进程环境注入，避免 token 落盘到 .git/config。
  const remoteUrl = `https://github.com/${repo}.git`
  try {
    const remotes = execSync("git remote", { cwd: root, timeout: 5000, encoding: "utf-8" }).trim()
    if (!remotes) {
      execFileSync("git", ["remote", "add", "origin", remoteUrl], { cwd: root, timeout: 10000, encoding: "utf-8" })
    } else {
      execFileSync("git", ["remote", "set-url", "origin", remoteUrl], { cwd: root, timeout: 10000, encoding: "utf-8" })
    }
  } catch {
    return { ok: false, error: "无法安全配置 Git remote" }
  }

  // 写入 step
  await addStep(supabase, userId, taskId, {
    kind: "tool_call",
    label: `git push ${currentBranch}`,
    detail: `推送到 ${repo}`,
  })

  // 执行 push（不 force）
  try {
    execFileSync("git", ["push", "origin", currentBranch], {
      cwd: root, timeout: 120_000, maxBuffer: 512 * 1024, encoding: "utf-8",
      env: gitAuthEnv(githubToken),
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

  if (isProtectedBranch(headBranch)) {
    return { ok: false, error: `禁止从 ${headBranch} 创建 PR` }
  }

  const base = options.base || detail.branch || "main"

  // 发布阶段工作区通常已经 commit，普通 git diff 会为空；应比较 base...HEAD。
  let changedFiles: { path: string; status: string }[] = []
  let diff = ""
  try {
    const nameStatus = execFileSync("git", ["diff", "--name-status", `${base}...HEAD`], {
      cwd: root, timeout: 15_000, maxBuffer: 512 * 1024, encoding: "utf-8",
    })
    changedFiles = nameStatus.trim().split("\n").filter(Boolean).map(line => {
      const [code, ...pathParts] = line.split("\t")
      const path = pathParts.at(-1) ?? ""
      const status = code.startsWith("A") ? "added" : code.startsWith("D") ? "deleted" : "modified"
      return { path, status }
    }).filter(file => file.path)
    diff = execFileSync("git", ["diff", "--no-color", `${base}...HEAD`], {
      cwd: root, timeout: 30_000, maxBuffer: 2 * 1024 * 1024, encoding: "utf-8",
    })
  } catch {
    const changed = getChangedFiles(taskId, userId)
    changedFiles = changed.ok ? changed.data.files : []
    diff = getWorkspaceDiff(taskId, userId)
  }

  // 构建 PR title
  const title = options.title || `Agent: ${detail.goal.slice(0, 60)}`

  // 构建 PR body
  const risk = checkRiskFiles(changedFiles.map(f => f.path))
  const fileList = changedFiles.map(f => `- ${f.status === "added" ? "A" : f.status === "modified" ? "M" : f.status === "deleted" ? "D" : "?"} \`${f.path}\``).join("\n")
  const riskNote = risk.blocked.length > 0 ? `\n### ⚠️ 高危文件已拦截\n${risk.blocked.map(f => `- ${f}`).join("\n")}\n` : ""
  const warnNote = risk.warnings.length > 0 ? `\n### ⚡ 中风险文件\n${risk.warnings.map(f => `- ${f}`).join("\n")}\n` : ""
  const latestVerification = new Map<string, boolean>()
  for (const artifact of [...detail.artifacts].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    const name = typeof artifact.meta?.name === "string" ? artifact.meta.name : null
    if (name && typeof artifact.meta?.passed === "boolean" && !latestVerification.has(name)) {
      latestVerification.set(name, artifact.meta.passed)
    }
  }
  const verificationNote = latestVerification.size
    ? [...latestVerification].map(([name, passed]) => `- ${name}: **${passed ? "通过" : "失败"}**`).join("\n")
    : "- 未运行自动测试（仅完成静态 diff 核对）"

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
    "## 验证状态",
    verificationNote,
    "",
    "## 备注",
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
      signal: AbortSignal.timeout(30_000),
    })

    if (!res.ok && res.status === 422) {
      const owner = repo.split("/")[0]
      const query = new URLSearchParams({ state: "open", head: `${owner}:${headBranch}`, base })
      const existing = await fetch(`https://api.github.com/repos/${repo}/pulls?${query}`, {
        headers: {
          Authorization: `Bearer ${githubToken}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "mychat-agent",
        },
        signal: AbortSignal.timeout(30_000),
      }).catch(() => null)
      const pulls = existing?.ok ? await existing.json().catch(() => []) : []
      const first = Array.isArray(pulls) ? pulls[0] : null
      if (first?.html_url) {
        prUrl = String(first.html_url)
        prNumber = Number(first.number) || null
      }
    }
    if (!res.ok && !prUrl) {
      const err = await res.json().catch(() => ({}))
      const msg = (err as any)?.message ?? `HTTP ${res.status}`
      return { ok: false, error: `创建 PR 失败：${msg}` }
    }

    if (!prUrl) {
      const pr = await res.json()
      prUrl = (pr as any).html_url ?? ""
      prNumber = (pr as any).number ?? null
    }
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
  const taskDetail = await getTaskDetail(supabase, userId, taskId)
  if (!("workspace" in taskDetail)) return { ok: false, error: "任务不存在", stage: "task" }

  // Step 1: 检查 status。若上次已经 commit 但 push/PR 失败，允许从现有 commit 幂等重试。
  const status = getWorkspaceGitStatus(taskId, userId)
  if (!status.ok) return { ok: false, error: status.error, stage: "status" }
  const canResumeCommittedPublish = !status.hasChanges
    && !!taskDetail.commitSha
    && taskDetail.commitSha === status.commitSha
    && !taskDetail.pullRequestUrl
  if (!status.hasChanges && !canResumeCommittedPublish) {
    return { ok: false, error: "没有可提交的改动", stage: "status", status }
  }

  const currentUpdatedAt = new Date(taskDetail.updatedAt).getTime()
  if (taskDetail.status === "creating_pr" && Date.now() - currentUpdatedAt < 5 * 60_000) {
    return { ok: false, error: "发布正在进行，请勿重复提交", stage: "lock", status }
  }
  let claimQuery = supabase
    .from("agent_tasks")
    .update({ status: "creating_pr", error: null, updated_at: new Date().toISOString() })
    .eq("id", taskId)
    .eq("user_id", userId)
  claimQuery = taskDetail.status === "creating_pr"
    ? claimQuery.eq("status", "creating_pr").eq("updated_at", taskDetail.updatedAt)
    : claimQuery.neq("status", "creating_pr")
  const { data: claimed, error: claimError } = await claimQuery
    .select("id")
    .maybeSingle()
  if (claimError || !claimed) {
    return { ok: false, error: "发布正在进行，请勿重复提交", stage: "lock", status }
  }

  await addStep(supabase, userId, taskId, {
    kind: "info",
    label: "开始发布",
    detail: `${status.changedFiles?.length ?? 0} 个待提交文件`,
  })

  // Step 2: Commit
  const goal = taskDetail.goal
  const msg = options.message || `Agent: ${goal.slice(0, 60) || "code changes"}`

  let commit: CommitResult
  if (canResumeCommittedPublish) {
    commit = { ok: true, commitSha: taskDetail.commitSha!, message: msg, changedFiles: [] }
  } else {
    commit = await commitWorkspaceChanges(taskId, userId, msg, supabase)
    if (!commit.ok) {
      await updateTaskStatus(supabase, userId, taskId, "failed", { error: commit.error })
      return { ok: false, error: commit.error, stage: "commit", status, commit }
    }
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
