// Git workspace 操作：clone、branch 创建、checkout。
// 所有 Git 操作通过 child_process.exec 执行，超时保护，token 不进命令参数。

import { execFile } from "child_process"
import { promisify } from "util"
import { mkdir, rm } from "fs/promises"
import { existsSync } from "fs"
import { join } from "path"
import { log } from "@/lib/logger"
import { WORKSPACE_ROOT as ROOT } from "./workspace-paths"
import { errorMessage, recordText } from '@/lib/unknown-value'

const execFileAsync = promisify(execFile)

const CLONE_TIMEOUT_MS = 120_000  // clone 可能较慢（大仓库），给 2 分钟
const GIT_TIMEOUT_MS = 30_000    // 其他 git 操作 30 秒

// branch slug：目标摘要 + 时间戳
// 确保不会出现空 slug（如 agent/-5e1l）
function slugify(text: string): string {
  if (!text || !text.trim()) return "task"
  let s = text
    .replace(/[^a-z0-9一-鿿_-]/gi, "-")  // 非法字符 → 横线
    .replace(/-+/g, "-")                  // 合并连续横线
    .replace(/^-|-$/g, "")                // 去除首尾横线
    .slice(0, 40)                         // 截断
  // 去掉后必须是纯小写字母数字横线组合，开头必须是字母
  s = s.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "")
  if (!s || s.length < 1) s = "task"
  return s
}

function agentBranch(taskGoal: string, fallback?: string): string {
  let slug = slugify(taskGoal)
  // 双重保险：若 slug 仍为空或不合法，用 fallback 或 taskId 前 8 位
  if (!slug || slug === "-" || slug.length < 1) {
    slug = fallback?.slice(0, 8) || "task"
  }
  const ts = Date.now().toString(36)
  return `agent/${slug}-${ts}`
}

// clone 时 token 通过环境变量注入，绝不出现在命令字符串中。
// 用 GIT_ASKPASS 空字符串禁用密码弹窗。
function gitEnv(token?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_ASKPASS: "echo",
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
  }
  if (token) {
    const credentials = Buffer.from(`x-access-token:${token}`).toString("base64")
    env.GIT_CONFIG_COUNT = "1"
    env.GIT_CONFIG_KEY_0 = "http.extraHeader"
    env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${credentials}`
  }
  return env
}

// ── 克隆仓库 ──

export type CloneResult = {
  path: string
  repo: string
  branch: string
  agentBranch: string
} | {
  error: string
}

export async function cloneWorkspace(
  userId: string, taskId: string,
  repo: string, token: string, goal: string, baseBranch = "main",
): Promise<CloneResult> {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    return { error: "GitHub 仓库格式无效" }
  }
  const base = join(ROOT, userId, taskId)
  const branch = agentBranch(goal)

  // 建目录
  try {
    await mkdir(base, { recursive: true })
  } catch (error) {
    const msg = `创建 workspace 目录失败: ${base} (${errorMessage(error)})`
    log.error("gitWorkspace", msg)
    return { error: msg }
  }

  // 如果目录已存在且 .git 目录有效，跳过 clone
  if (existsSync(join(base, ".git"))) {
    log.info("gitWorkspace", "Workspace 已存在，跳过 clone", { base })
    // 尝试创建 agent branch
    try {
      await execFileAsync("git", ["checkout", "-b", branch], { cwd: base, timeout: GIT_TIMEOUT_MS, env: gitEnv() })
    } catch {
      // branch 可能已存在，尝试切换
      try { await execFileAsync("git", ["checkout", branch], { cwd: base, timeout: GIT_TIMEOUT_MS, env: gitEnv() }) }
      catch { /* 保持当前分支 */ }
    }
    return { path: base, repo, branch: baseBranch, agentBranch: branch }
  }

  // 清理残留（如果有目录但无 .git）
  try { await rm(base, { recursive: true, force: true }) } catch {}
  try { await mkdir(base, { recursive: true }) } catch {}

  // Clone
  const url = `https://github.com/${repo}.git`
  try {
    log.info("gitWorkspace", `Executing git clone for ${repo}`, { branch: baseBranch })
    const { stderr } = await execFileAsync("git", ["clone", "--single-branch", "--branch", baseBranch, url, base], {
      timeout: CLONE_TIMEOUT_MS,
      env: gitEnv(token),
    })
    // git clone 的输出通常在 stderr
    const out = stderr.trim()
    log.info("gitWorkspace", `Clone completed for ${repo}`, { output: out.slice(0, 200) })
  } catch (error) {
    const msg = recordText(error, 'stderr').trim() || errorMessage(error)
    // 彻底删除失败残留，不打日志暴露 token
    const cleanMsg = msg.replace(/https:\/\/[^@]+@/g, "https://***@")
      .replace(/x-access-token:[^@\s]+/g, "x-access-token:***")
    log.error("gitWorkspace", `Clone failed for ${repo}`, { error: cleanMsg.slice(0, 300) })
    try { await rm(base, { recursive: true, force: true }) } catch {}
    return { error: `Git clone 失败: ${cleanMsg.slice(0, 500)}` }
  }

  // 创建 agent branch
  try {
    await execFileAsync("git", ["checkout", "-b", branch], {
      cwd: base, timeout: GIT_TIMEOUT_MS, env: gitEnv(),
    })
    log.info("gitWorkspace", `Created agent branch ${branch}`, { repo })
  } catch (error) {
    const msg = recordText(error, 'stderr').trim() || errorMessage(error)
    log.warn("gitWorkspace", `Agent branch creation failed: ${msg.slice(0, 200)}`)
    // branch 已存在则切换
    try { await execFileAsync("git", ["checkout", branch], { cwd: base, timeout: GIT_TIMEOUT_MS, env: gitEnv() }) }
    catch { /* 保持 default branch */ }
  }

  return { path: base, repo, branch: baseBranch, agentBranch: branch }
}

// ── 获取 workspace 信息 ──

export async function getGitInfo(path: string): Promise<{ branch: string; commit: string; remote: string } | { error: string }> {
  try {
    const [br, co, rem] = await Promise.all([
      execFileAsync("git", ["branch", "--show-current"], { cwd: path, timeout: GIT_TIMEOUT_MS, env: gitEnv() }),
      execFileAsync("git", ["rev-parse", "HEAD"], { cwd: path, timeout: GIT_TIMEOUT_MS, env: gitEnv() }),
      execFileAsync("git", ["remote", "get-url", "origin"], { cwd: path, timeout: GIT_TIMEOUT_MS, env: gitEnv() }),
    ])
    return {
      branch: br.stdout.trim(),
      commit: co.stdout.trim(),
      // 清除 remote URL 中的 token
      remote: rem.stdout.trim().replace(/https:\/\/[^@]+@/g, "https://***@"),
    }
  } catch (error) {
    return { error: recordText(error, 'stderr').trim() || errorMessage(error, "git info failed") }
  }
}
