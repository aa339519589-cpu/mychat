// Code 板块的数据访问层：会话 / 消息 / 记忆，全部独立于主聊天的表。
// 受 RLS 隔离（用户只能读写自己的）。主聊天侧栏永远不碰这些表。
import { createClient } from "@/lib/supabase/client"

type CodeRole = "user" | "assistant"

// AI 规划的一个动作（建仓库 / 写文件 / 删文件 / 上线），等用户确认或自动执行
export type PlanAction =
  | { kind: "create_repo"; name: string; description?: string; private?: boolean }
  | { kind: "write_file"; path: string; oldContent: string; newContent: string }
  | { kind: "delete_file"; path: string }
  | { kind: "enable_pages" }

// 执行结果（直接推送后的回执 / workspace PR 后的回执）
export type ApplyResult = {
  repo?: string; repoUrl?: string; pagesUrl?: string; commitSha?: string; created?: boolean
  mode?: "workspace_pr" | "direct_push"
  pullRequestUrl?: string; pullRequestNumber?: number; branch?: string
  merged?: boolean; mergeCommitSha?: string
  pagesStatus?: "ready" | "pending" | "failed"
  pagesError?: string
  message?: string
}

// 终端里的一个步骤（工具调用进度）
export type CodeStep = { kind: "list" | "read" | "edit" | "memory" | "repo" | "deploy"; label: string }

export type CodeMessage = {
  id: string
  role: CodeRole
  content: string
  steps?: CodeStep[]
  plan?: PlanAction[]
  result?: ApplyResult
  taskId?: string
  isError?: boolean
}

export type CodeSession = { id: string; repo: string; title: string; date: string }
export type CodeMemory = { id: string; content: string }

function fmtDate(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) return "今日"
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

// ───────────── 会话 ─────────────
export async function fetchCodeSessions(repo: string): Promise<CodeSession[]> {
  const supabase = createClient()
  const { data } = await supabase
    .from("code_sessions")
    .select("id, repo, title, updated_at")
    .eq("repo", repo)
    .order("updated_at", { ascending: false })
    .limit(50)
  return (data ?? []).map((r: any) => ({ id: r.id, repo: r.repo, title: r.title, date: fmtDate(r.updated_at) }))
}

export async function createCodeSession(userId: string, repo: string, title: string): Promise<string | null> {
  const supabase = createClient()
  const id = crypto.randomUUID()
  const { error } = await supabase.from("code_sessions").insert({ id, user_id: userId, repo, title })
  return error ? null : id
}

export async function touchCodeSession(id: string) {
  const supabase = createClient()
  await supabase.from("code_sessions").update({ updated_at: new Date().toISOString() }).eq("id", id)
}

// ───────────── 消息 ─────────────
export async function fetchCodeMessages(sessionId: string): Promise<CodeMessage[]> {
  const supabase = createClient()
  const { data } = await supabase
    .from("code_messages")
    .select("id, role, content, meta")
    .eq("session_id", sessionId)
    .order("created_at")
  return (data ?? []).map((r: any) => ({
    id: r.id,
    role: r.role,
    content: r.content,
    steps: r.meta?.steps,
    plan: r.meta?.plan,
    result: r.meta?.result,
    taskId: r.meta?.taskId,
  }))
}

export async function insertCodeMessage(
  userId: string, sessionId: string, msg: CodeMessage,
): Promise<void> {
  const supabase = createClient()
  const meta: Record<string, unknown> = {}
  if (msg.steps?.length) meta.steps = msg.steps
  if (msg.plan?.length) meta.plan = msg.plan
  if (msg.result) meta.result = msg.result
  if (msg.taskId) meta.taskId = msg.taskId
  await supabase.from("code_messages").insert({
    id: msg.id, session_id: sessionId, user_id: userId, role: msg.role, content: msg.content,
    meta: Object.keys(meta).length ? meta : null,
  })
}

export function modelContent(msg: CodeMessage): string {
  if (!msg.result) return msg.content
  const r = msg.result
  const facts = [
    r.repo && `仓库：${r.repo}`,
    r.repoUrl && `仓库地址：${r.repoUrl}`,
    r.commitSha && `提交：${r.commitSha}`,
    r.branch && `分支：${r.branch}`,
    r.pullRequestUrl && `Pull Request：${r.pullRequestUrl}`,
    r.merged && `Pull Request 已合并：是`,
    r.mergeCommitSha && `合并提交：${r.mergeCommitSha}`,
    r.pagesUrl && `Pages 地址：${r.pagesUrl}`,
    r.pagesStatus && `Pages 状态：${r.pagesStatus}`,
    r.pagesError && `Pages 错误：${r.pagesError}`,
    r.message && `执行说明：${r.message}`,
  ].filter(Boolean)
  return [msg.content, `[平台执行回执]\n${facts.join("\n")}`].filter(Boolean).join("\n\n")
}

export function toCodeModelMessages(messages: CodeMessage[]) {
  return messages.map(msg => ({ role: msg.role, content: modelContent(msg) }))
}

// ───────────── 记忆（按 repo 隔离）─────────────
export async function fetchCodeMemories(repo: string): Promise<CodeMemory[]> {
  const supabase = createClient()
  const { data } = await supabase
    .from("code_memories")
    .select("id, content")
    .eq("repo", repo)
    .order("created_at")
  return (data ?? []).map((r: any) => ({ id: r.id, content: r.content }))
}

export async function insertCodeMemory(userId: string, repo: string, content: string): Promise<CodeMemory | null> {
  const supabase = createClient()
  const id = crypto.randomUUID()
  const { error } = await supabase.from("code_memories").insert({ id, user_id: userId, repo, content })
  return error ? null : { id, content }
}

export async function deleteCodeMemory(id: string) {
  const supabase = createClient()
  await supabase.from("code_memories").delete().eq("id", id)
}
