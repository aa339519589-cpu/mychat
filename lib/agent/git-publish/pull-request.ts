import type { SupabaseClient } from "@supabase/supabase-js"

import { addArtifact, addStep, getTaskDetail, updateTaskStatus } from "../data"
import { redactSensitive } from "../path-security"
import { isProtectedBranch } from "../risk"
import { workspaceRoot } from "../workspace"
import { checkRiskFiles } from "./shared"
import { runGit } from "./git-command"
import type { PRResult } from "./types"

type ChangedFile = { path: string; status: string }

function throwIfAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted()
}

function requestSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(30_000)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

function parseNameStatus(output: string): ChangedFile[] {
  return output.trim().split("\n").filter(Boolean).map(line => {
    const [code, ...pathParts] = line.split("\t")
    const path = pathParts.at(-1) ?? ""
    const status = code.startsWith("A")
      ? "added"
      : code.startsWith("D") ? "deleted" : "modified"
    return { path, status }
  }).filter(file => file.path)
}

async function committedChanges(
  root: string,
  base: string,
  signal?: AbortSignal,
): Promise<{ changedFiles: ChangedFile[]; diff: string }> {
  try {
    const [nameStatus, diff] = await Promise.all([
      runGit(["diff", "--name-status", `${base}...HEAD`], {
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
      runGit(["diff", "--name-status", "HEAD"], {
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

export async function createWorkspacePullRequest(
  taskId: string,
  userId: string,
  githubToken: string,
  supabase: SupabaseClient,
  options: { title?: string; body?: string; base?: string; signal?: AbortSignal } = {},
): Promise<PRResult> {
  const detail = await getTaskDetail(supabase, userId, taskId)
  if (!("workspace" in detail)) return { ok: false, error: "任务不存在" }
  const repo = detail.repo
  if (!repo) return { ok: false, error: "任务未关联仓库" }

  const root = workspaceRoot(taskId, userId)
  let headBranch = detail.agentBranch
  if (!headBranch) {
    try {
      headBranch = (await runGit(["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: root,
        timeoutMs: 5000,
        signal: options.signal,
      })).trim()
    } catch {
      throwIfAborted(options.signal)
      return { ok: false, error: "无法确定 head branch" }
    }
  }
  if (isProtectedBranch(headBranch)) {
    return { ok: false, error: `禁止从 ${headBranch} 创建 PR` }
  }

  const base = options.base || detail.branch || "main"
  const { changedFiles, diff } = await committedChanges(root, base, options.signal)
  const title = options.title || `Agent: ${detail.goal.slice(0, 60)}`
  const risk = checkRiskFiles(changedFiles.map(file => file.path))
  const fileList = changedFiles.map(file => {
    const marker = file.status === "added"
      ? "A"
      : file.status === "modified" ? "M" : file.status === "deleted" ? "D" : "?"
    return `- ${marker} \`${file.path}\``
  }).join("\n")
  const riskNote = risk.blocked.length > 0
    ? `\n### ⚠️ 高危文件已拦截\n${risk.blocked.map(file => `- ${file}`).join("\n")}\n`
    : ""
  const warningNote = risk.warnings.length > 0
    ? `\n### ⚡ 中风险文件\n${risk.warnings.map(file => `- ${file}`).join("\n")}\n`
    : ""

  const latestVerification = new Map<string, boolean>()
  for (const artifact of [...detail.artifacts].sort((left, right) => (
    right.createdAt.localeCompare(left.createdAt)
  ))) {
    const name = typeof artifact.meta?.name === "string" ? artifact.meta.name : null
    if (name && typeof artifact.meta?.passed === "boolean" && !latestVerification.has(name)) {
      latestVerification.set(name, artifact.meta.passed)
    }
  }
  const verificationNote = latestVerification.size
    ? [...latestVerification]
      .map(([name, passed]) => `- ${name}: **${passed ? "通过" : "失败"}**`)
      .join("\n")
    : "- 未运行自动测试（仅完成静态 diff 核对）"

  const body = options.body || [
    "## 任务目标",
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
    warningNote,
    "## 验证状态",
    verificationNote,
    "",
    "## 备注",
    "- 回滚说明：本地 workspace 有 snapshot，可回滚",
    "- 由 mychat Agent 创建",
    "",
    "🤖 Generated with [Claude Code](https://claude.com/claude-code)",
  ].join("\n")

  await addStep(supabase, userId, taskId, {
    kind: "tool_call",
    label: "创建 Pull Request",
    detail: `${headBranch} → ${base}`,
  })

  let pullRequestUrl = ""
  let pullRequestNumber: number | null = null
  try {
    const response = await fetch(`https://api.github.com/repos/${repo}/pulls`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${githubToken}`,
        "Content-Type": "application/json",
        Accept: "application/vnd.github+json",
        "User-Agent": "mychat-agent",
      },
      body: JSON.stringify({ title, body, head: headBranch, base }),
      signal: requestSignal(options.signal),
    })

    if (!response.ok && response.status === 422) {
      const owner = repo.split("/")[0]
      const query = new URLSearchParams({ state: "open", head: `${owner}:${headBranch}`, base })
      const existing = await fetch(`https://api.github.com/repos/${repo}/pulls?${query}`, {
        headers: {
          Authorization: `Bearer ${githubToken}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "mychat-agent",
        },
        signal: requestSignal(options.signal),
      }).catch(() => null)
      const pulls = existing?.ok ? await existing.json().catch(() => []) : []
      const first = Array.isArray(pulls) ? pulls[0] : null
      if (first?.html_url) {
        pullRequestUrl = String(first.html_url)
        pullRequestNumber = Number(first.number) || null
      }
    }
    if (!response.ok && !pullRequestUrl) {
      const error = await response.json().catch(() => ({}))
      const message = (error as { message?: string }).message ?? `HTTP ${response.status}`
      return { ok: false, error: `创建 PR 失败：${message}` }
    }
    if (!pullRequestUrl) {
      const pullRequest = await response.json() as { html_url?: string; number?: number }
      pullRequestUrl = pullRequest.html_url ?? ""
      pullRequestNumber = pullRequest.number ?? null
    }
  } catch (error) {
    throwIfAborted(options.signal)
    const message = error && typeof error === "object" && "message" in error
      ? (error as { message?: unknown }).message
      : undefined
    return { ok: false, error: `创建 PR 失败：${String(message ?? "网络错误")}` }
  }

  if (!pullRequestUrl) return { ok: false, error: "创建 PR 成功但未获取到 URL" }

  await updateTaskStatus(supabase, userId, taskId, "completed", {
    finishedAt: new Date().toISOString(),
    pullRequestUrl,
    pullRequestNumber: pullRequestNumber ?? undefined,
    agentBranch: headBranch,
    commitSha: detail.commitSha ?? undefined,
  })
  await addArtifact(supabase, userId, {
    taskId,
    kind: "pr_link",
    title: `PR: ${title.slice(0, 60)}`,
    url: pullRequestUrl,
    content: `Pull Request: ${pullRequestUrl}\nBranch: ${headBranch} → ${base}\nFiles: ${changedFiles.length}`,
    meta: {
      prUrl: pullRequestUrl,
      prNumber: pullRequestNumber,
      headBranch,
      base,
      changedFiles: changedFiles.map(file => file.path),
      commitSha: detail.commitSha,
    },
  })

  return {
    ok: true,
    pullRequestUrl,
    pullRequestNumber: pullRequestNumber ?? undefined,
    title,
    head: headBranch,
    base,
  }
}
