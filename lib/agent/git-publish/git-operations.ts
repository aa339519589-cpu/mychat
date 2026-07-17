import { existsSync } from "fs"
import type { SupabaseClient } from "@/lib/supabase/types"

import { addArtifact, addStep, getTaskDetail, updateTaskStatus } from "../data"
import { redactSensitive } from "../path-security"
import { isProtectedBranch } from "../risk"
import { workspaceRoot } from "../workspace"
import { assessInitialRepositoryPublication } from "../publication-safety"
import { runGit } from "./git-command"
import {
  checkRiskFiles,
  commandError,
  ensureWorkspaceGitIdentity,
  gitAuthEnv,
  isValidGitHubRepository,
} from "./shared"
import type { CommitResult, GitStatus, PushResult } from "./types"

function throwIfAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted()
}

async function currentBranch(root: string, signal?: AbortSignal): Promise<string> {
  return (await runGit(["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: root,
    timeoutMs: 5000,
    signal,
  })).trim()
}

function changedFilesFromPorcelain(output: string): Array<{ path: string; status: string }> {
  const entries = output.split("\0").filter(Boolean)
  const files: Array<{ path: string; status: string }> = []
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]
    const code = entry.slice(0, 2)
    const path = entry.slice(3)
    if (!path) continue
    const status = code === "??" || code.includes("A")
      ? "added"
      : code.includes("D") ? "deleted" : "modified"
    files.push({ path, status })
    if (code.includes("R") || code.includes("C")) index++
  }
  return files
}

function nulSeparated(output: string): string[] {
  return output.split("\0").filter(Boolean)
}

export async function getWorkspaceGitStatus(
  taskId: string,
  userId: string,
  signal?: AbortSignal,
): Promise<GitStatus> {
  const root = workspaceRoot(taskId, userId)
  if (!existsSync(root)) return { ok: false, error: "Workspace 不存在" }

  let branch = ""
  try {
    branch = await currentBranch(root, signal)
  } catch {
    throwIfAborted(signal)
    return { ok: false, error: "无法获取当前分支" }
  }

  let changedFiles: Array<{ path: string; status: string }> = []
  let diffStat = ""
  let diffPreview = ""
  let hasChanges = false
  try {
    const porcelain = await runGit(["status", "--porcelain", "-z"], {
      cwd: root, timeoutMs: 10_000, maxBuffer: 512 * 1024, signal,
    })
    changedFiles = changedFilesFromPorcelain(porcelain)
    hasChanges = changedFiles.length > 0
  } catch {
    throwIfAborted(signal)
    return { ok: false, error: "无法读取 Workspace Git 状态" }
  }
  const [stat, preview] = await Promise.all([
    runGit(["diff", "--stat"], {
      cwd: root, timeoutMs: 10_000, maxBuffer: 256 * 1024, signal,
    }).catch(() => ""),
    runGit(["diff", "--name-only"], {
      cwd: root, timeoutMs: 10_000, maxBuffer: 256 * 1024, signal,
    }).catch(() => ""),
  ])
  throwIfAborted(signal)
  diffStat = stat
  diffPreview = preview

  let commitSha: string | null = null
  try {
    commitSha = (await runGit(["rev-parse", "HEAD"], {
      cwd: root,
      timeoutMs: 5000,
      signal,
    })).trim()
  } catch {
    throwIfAborted(signal)
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
  signal?: AbortSignal,
): Promise<CommitResult> {
  const root = workspaceRoot(taskId, userId)
  if (!existsSync(root)) return { ok: false, error: "Workspace 不存在" }

  const detail = await getTaskDetail(supabase, userId, taskId)
  if (!("workspace" in detail)) return { ok: false, error: "任务不存在或无权访问" }

  let branch = ""
  try {
    branch = await currentBranch(root, signal)
  } catch {
    throwIfAborted(signal)
    return { ok: false, error: "无法获取当前分支" }
  }
  if (isProtectedBranch(branch)) {
    return { ok: false, error: `禁止在 ${branch} 分支上 commit，请先切换到 agent branch` }
  }

  let hasChanges = false
  try {
    hasChanges = (await runGit(["status", "--porcelain"], {
      cwd: root,
      timeoutMs: 5000,
      maxBuffer: 64 * 1024,
      signal,
    })).trim().length > 0
  } catch {
    throwIfAborted(signal)
    // The explicit no-changes error below is safer than attempting an empty commit.
  }
  if (!hasChanges) return { ok: false, error: "没有可提交的改动" }

  let changedFiles: string[] = []
  try {
    const [tracked, untrackedOutput] = await Promise.all([
      runGit(["diff", "--name-only", "-z", "HEAD"], {
        cwd: root, timeoutMs: 10_000, maxBuffer: 128 * 1024, signal,
      }),
      runGit(["ls-files", "--others", "--exclude-standard", "-z"], {
        cwd: root, timeoutMs: 5000, maxBuffer: 64 * 1024, signal,
      }),
    ])
    changedFiles = nulSeparated(tracked)
    changedFiles.push(...nulSeparated(untrackedOutput))
  } catch {
    throwIfAborted(signal)
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
    diffStat = await runGit(["diff", "--stat", "HEAD"], {
      cwd: root,
      timeoutMs: 10_000,
      maxBuffer: 128 * 1024,
      signal,
    })
  } catch {
    throwIfAborted(signal)
    // Diff stats are optional metadata.
  }
  const safeMessage = message.slice(0, 200) || "Agent: code changes"

  try {
    const commitEnv = await ensureWorkspaceGitIdentity(root, signal)
    await runGit(["add", "-A", "--", ".", ":(exclude).claude/snapshots/**"], {
      cwd: root,
      timeoutMs: 15_000,
      maxBuffer: 256 * 1024,
      env: commitEnv,
      signal,
    })

    let stagedFiles: string[] = []
    try {
      stagedFiles = nulSeparated(await runGit([
        "diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z",
      ], {
        cwd: root,
        timeoutMs: 10_000,
        maxBuffer: 128 * 1024,
        env: commitEnv,
        signal,
      }))
    } catch {
      throwIfAborted(signal)
      // An empty list is handled by git commit below.
    }
    const { blocked: stagedBlocked } = checkRiskFiles(stagedFiles)
    if (stagedBlocked.length > 0) {
      await runGit(["reset", "HEAD", "--", "."], {
        cwd: root,
        timeoutMs: 10_000,
        env: commitEnv,
        signal,
      })
      return { ok: false, error: `禁止提交高危文件：${stagedBlocked.join("、")}` }
    }

    try {
      for (const path of stagedFiles) {
        const content = await runGit(["show", `:${path}`], {
          cwd: root,
          timeoutMs: 10_000,
          maxBuffer: 2 * 1024 * 1024 + 1,
          env: commitEnv,
          signal,
        })
        const safety = assessInitialRepositoryPublication([{ path, content }])
        if (!safety.ok) {
          await runGit(["reset", "HEAD", "--", "."], {
            cwd: root,
            timeoutMs: 10_000,
            env: commitEnv,
            signal,
          })
          return { ok: false, error: safety.reason }
        }
      }
    } catch {
      throwIfAborted(signal)
      await runGit(["reset", "HEAD", "--", "."], {
        cwd: root,
        timeoutMs: 10_000,
        env: commitEnv,
        signal,
      }).catch(() => undefined)
      return { ok: false, error: "无法完整扫描暂存内容，已拒绝提交" }
    }

    await runGit(["commit", "-m", safeMessage], {
      cwd: root,
      timeoutMs: 30_000,
      maxBuffer: 256 * 1024,
      env: commitEnv,
      signal,
    })
  } catch (error) {
    throwIfAborted(signal)
    return { ok: false, error: `Commit 失败：${commandError(error)}` }
  }

  let commitSha = ""
  try {
    commitSha = (await runGit(["rev-parse", "HEAD"], {
      cwd: root,
      timeoutMs: 5000,
      signal,
    })).trim()
  } catch {
    throwIfAborted(signal)
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
  signal?: AbortSignal,
): Promise<PushResult> {
  const root = workspaceRoot(taskId, userId)
  if (!existsSync(root)) return { ok: false, error: "Workspace 不存在" }

  let branch = ""
  try {
    branch = await currentBranch(root, signal)
  } catch {
    throwIfAborted(signal)
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
    const remotes = (await runGit(["remote"], {
      cwd: root,
      timeoutMs: 5000,
      signal,
    })).trim()
    if (!remotes) {
      await runGit(["remote", "add", "origin", remoteUrl], {
        cwd: root,
        timeoutMs: 10_000,
        signal,
      })
    } else {
      await runGit(["remote", "set-url", "origin", remoteUrl], {
        cwd: root,
        timeoutMs: 10_000,
        signal,
      })
    }
  } catch {
    throwIfAborted(signal)
    return { ok: false, error: "无法安全配置 Git remote" }
  }

  await addStep(supabase, userId, taskId, {
    kind: "tool_call",
    label: `git push ${branch}`,
    detail: `推送到 ${repo}`,
  })
  try {
    await runGit(["push", "origin", branch], {
      cwd: root,
      timeoutMs: 120_000,
      maxBuffer: 512 * 1024,
      env: gitAuthEnv(githubToken),
      signal,
    })
  } catch (error) {
    throwIfAborted(signal)
    const stderr = commandError(error).replace(githubToken, "***")
    return { ok: false, error: `Push 失败：${stderr}` }
  }

  return { ok: true, branch, remote: repo }
}
