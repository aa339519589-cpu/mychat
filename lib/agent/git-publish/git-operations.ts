import { execFileSync, execSync } from "child_process"
import { existsSync } from "fs"
import type { SupabaseClient } from "@supabase/supabase-js"

import { addArtifact, addStep, getTaskDetail, updateTaskStatus } from "../data"
import { redactSensitive } from "../path-security"
import { isProtectedBranch } from "../risk"
import { getChangedFiles, workspaceRoot } from "../workspace"
import {
  checkRiskFiles,
  commandError,
  ensureWorkspaceGitIdentity,
  gitAuthEnv,
  isValidGitHubRepository,
} from "./shared"
import type { CommitResult, GitStatus, PushResult } from "./types"

function currentBranch(root: string): string {
  return execSync("git rev-parse --abbrev-ref HEAD", {
    cwd: root,
    timeout: 5000,
    encoding: "utf-8",
  }).trim()
}

export function getWorkspaceGitStatus(taskId: string, userId: string): GitStatus {
  const root = workspaceRoot(taskId, userId)
  if (!existsSync(root)) return { ok: false, error: "Workspace 不存在" }

  let branch = ""
  try {
    branch = currentBranch(root)
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
      cwd: root,
      timeout: 10000,
      maxBuffer: 256 * 1024,
      encoding: "utf-8",
    })
    diffPreview = execSync("git diff --name-only", {
      cwd: root,
      timeout: 10000,
      maxBuffer: 256 * 1024,
      encoding: "utf-8",
    })
    hasChanges = diffPreview.trim().length > 0
  } catch {
    // A clean diff produces an empty status.
  }

  try {
    const untracked = execSync("git ls-files --others --exclude-standard", {
      cwd: root,
      timeout: 5000,
      maxBuffer: 64 * 1024,
      encoding: "utf-8",
    }).trim()
    if (untracked) hasChanges = true
  } catch {
    // Untracked-file detection is best effort.
  }

  let commitSha: string | null = null
  try {
    commitSha = execSync("git rev-parse HEAD", {
      cwd: root,
      timeout: 5000,
      encoding: "utf-8",
    }).trim()
  } catch {
    // An unborn repository has no HEAD yet.
  }

  return {
    ok: true,
    currentBranch: branch,
    changedFiles,
    diffStat: redactSensitive(diffStat),
    diffPreview: redactSensitive(diffPreview),
    hasChanges,
    commitSha,
  }
}

export async function commitWorkspaceChanges(
  taskId: string,
  userId: string,
  message: string,
  supabase: SupabaseClient,
): Promise<CommitResult> {
  const root = workspaceRoot(taskId, userId)
  if (!existsSync(root)) return { ok: false, error: "Workspace 不存在" }

  const detail = await getTaskDetail(supabase, userId, taskId)
  if (!("workspace" in detail)) return { ok: false, error: "任务不存在或无权访问" }

  let branch = ""
  try {
    branch = currentBranch(root)
  } catch {
    return { ok: false, error: "无法获取当前分支" }
  }
  if (isProtectedBranch(branch)) {
    return { ok: false, error: `禁止在 ${branch} 分支上 commit，请先切换到 agent branch` }
  }

  let hasChanges = false
  try {
    hasChanges = execSync("git status --porcelain", {
      cwd: root,
      timeout: 5000,
      maxBuffer: 64 * 1024,
      encoding: "utf-8",
    }).trim().length > 0
  } catch {
    // The explicit no-changes error below is safer than attempting an empty commit.
  }
  if (!hasChanges) return { ok: false, error: "没有可提交的改动" }

  let changedFiles: string[] = []
  try {
    changedFiles = execSync("git diff --name-only HEAD", {
      cwd: root,
      timeout: 10000,
      maxBuffer: 128 * 1024,
      encoding: "utf-8",
    }).trim().split("\n").filter(Boolean)
    const untracked = execSync("git ls-files --others --exclude-standard", {
      cwd: root,
      timeout: 5000,
      maxBuffer: 64 * 1024,
      encoding: "utf-8",
    }).trim()
    if (untracked) changedFiles.push(...untracked.split("\n").filter(Boolean))
  } catch {
    // The staged-file check below is authoritative.
  }

  const { blocked } = checkRiskFiles(changedFiles)
  if (blocked.length > 0) {
    return { ok: false, error: `禁止提交高危文件：${blocked.join("、")}` }
  }

  await addStep(supabase, userId, taskId, {
    kind: "tool_call",
    label: "git commit",
    detail: `${changedFiles.length} 个文件`,
  })

  let diffStat = ""
  try {
    diffStat = execSync("git diff --stat HEAD", {
      cwd: root,
      timeout: 10000,
      maxBuffer: 128 * 1024,
      encoding: "utf-8",
    })
  } catch {
    // Diff stats are optional metadata.
  }
  const safeMessage = message.slice(0, 200) || "Agent: code changes"

  try {
    const commitEnv = ensureWorkspaceGitIdentity(root)
    execFileSync("git", ["add", "-A", "--", ".", ":(exclude).claude/snapshots/**"], {
      cwd: root,
      timeout: 15000,
      maxBuffer: 256 * 1024,
      encoding: "utf-8",
      env: commitEnv,
    })

    let stagedFiles: string[] = []
    try {
      stagedFiles = execSync("git diff --cached --name-only", {
        cwd: root,
        timeout: 10000,
        maxBuffer: 128 * 1024,
        encoding: "utf-8",
        env: commitEnv,
      }).trim().split("\n").filter(Boolean)
    } catch {
      // An empty list is handled by git commit below.
    }
    const { blocked: stagedBlocked } = checkRiskFiles(stagedFiles)
    if (stagedBlocked.length > 0) {
      execFileSync("git", ["reset", "HEAD", "--", "."], {
        cwd: root,
        timeout: 10000,
        encoding: "utf-8",
        env: commitEnv,
      })
      return { ok: false, error: `禁止提交高危文件：${stagedBlocked.join("、")}` }
    }

    execFileSync("git", ["commit", "-m", safeMessage], {
      cwd: root,
      timeout: 30000,
      maxBuffer: 256 * 1024,
      encoding: "utf-8",
      env: commitEnv,
    })
  } catch (error) {
    return { ok: false, error: `Commit 失败：${commandError(error)}` }
  }

  let commitSha = ""
  try {
    commitSha = execSync("git rev-parse HEAD", {
      cwd: root,
      timeout: 5000,
      encoding: "utf-8",
    }).trim()
  } catch {
    // Artifact metadata can tolerate a missing SHA.
  }

  const safeDiffStat = redactSensitive(diffStat)
  await addArtifact(supabase, userId, {
    taskId,
    kind: "diff",
    title: `Commit: ${safeMessage.slice(0, 50)}`,
    content: safeDiffStat.slice(0, 10000),
    meta: {
      commitSha,
      branch,
      changedFiles,
      diffStat: safeDiffStat.slice(0, 2000),
    },
  })
  await updateTaskStatus(supabase, userId, taskId, detail.status, {
    commitSha,
    agentBranch: branch,
  })

  return {
    ok: true,
    commitSha,
    message: safeMessage,
    changedFiles,
    diffStat: safeDiffStat,
  }
}

export async function pushAgentBranch(
  taskId: string,
  userId: string,
  githubToken: string,
  supabase: SupabaseClient,
): Promise<PushResult> {
  const root = workspaceRoot(taskId, userId)
  if (!existsSync(root)) return { ok: false, error: "Workspace 不存在" }

  let branch = ""
  try {
    branch = currentBranch(root)
  } catch {
    return { ok: false, error: "无法获取当前分支" }
  }
  if (isProtectedBranch(branch)) return { ok: false, error: `禁止推送 ${branch} 分支` }

  const detail = await getTaskDetail(supabase, userId, taskId)
  if (!("workspace" in detail)) return { ok: false, error: "任务不存在" }
  const repo = detail.repo
  if (!repo) return { ok: false, error: "任务未关联仓库" }
  if (!isValidGitHubRepository(repo)) {
    return { ok: false, error: "任务关联的 GitHub 仓库格式无效" }
  }

  const remoteUrl = `https://github.com/${repo}.git`
  try {
    const remotes = execSync("git remote", {
      cwd: root,
      timeout: 5000,
      encoding: "utf-8",
    }).trim()
    if (!remotes) {
      execFileSync("git", ["remote", "add", "origin", remoteUrl], {
        cwd: root,
        timeout: 10000,
        encoding: "utf-8",
      })
    } else {
      execFileSync("git", ["remote", "set-url", "origin", remoteUrl], {
        cwd: root,
        timeout: 10000,
        encoding: "utf-8",
      })
    }
  } catch {
    return { ok: false, error: "无法安全配置 Git remote" }
  }

  await addStep(supabase, userId, taskId, {
    kind: "tool_call",
    label: `git push ${branch}`,
    detail: `推送到 ${repo}`,
  })
  try {
    execFileSync("git", ["push", "origin", branch], {
      cwd: root,
      timeout: 120_000,
      maxBuffer: 512 * 1024,
      encoding: "utf-8",
      env: gitAuthEnv(githubToken),
    })
  } catch (error) {
    const stderr = commandError(error).replace(githubToken, "***")
    return { ok: false, error: `Push 失败：${stderr}` }
  }

  return { ok: true, branch, remote: repo }
}
