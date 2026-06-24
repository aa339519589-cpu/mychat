// Code 板块的数据访问层：会话 / 消息 / 记忆，全部独立于主聊天的表。
// 受 RLS 隔离（用户只能读写自己的）。主聊天侧栏永远不碰这些表。
import { createClient } from "@/lib/supabase/client"

export type CodeRole = "user" | "assistant"

// AI 规划的一个动作（建仓库 / 写文件 / 删文件 / 上线），等用户确认或自动执行
export type PlanAction =
  | { kind: "create_repo"; name: string; description?: string; private?: boolean }
  | { kind: "write_file"; path: string; oldContent: string; newContent: string }
  | { kind: "delete_file"; path: string }
  | { kind: "enable_pages" }

// 执行结果（直接推送后的回执）
export type ApplyResult = { repo?: string; repoUrl?: string; pagesUrl?: string; commitSha?: string; created?: boolean }

// 终端里的一个步骤（工具调用进度）
export type CodeStep = { kind: "list" | "read" | "edit" | "memory" | "repo" | "deploy"; label: string }

export type CodeMessage = {
  id: string
  role: CodeRole
  content: string
  steps?: CodeStep[]
  plan?: PlanAction[]
  result?: ApplyResult
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

export async function updateCodeSessionTitle(id: string, title: string) {
  const supabase = createClient()
  await supabase.from("code_sessions").update({ title, updated_at: new Date().toISOString() }).eq("id", id)
}

export async function touchCodeSession(id: string) {
  const supabase = createClient()
  await supabase.from("code_sessions").update({ updated_at: new Date().toISOString() }).eq("id", id)
}

export async function deleteCodeSession(id: string) {
  const supabase = createClient()
  await supabase.from("code_sessions").delete().eq("id", id)
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
  }))
}

export async function insertCodeMessage(
  userId: string, sessionId: string, msg: CodeMessage,
): Promise<void> {
  const supabase = createClient()
  const meta: any = {}
  if (msg.steps?.length) meta.steps = msg.steps
  if (msg.plan?.length) meta.plan = msg.plan
  if (msg.result) meta.result = msg.result
  await supabase.from("code_messages").insert({
    id: msg.id, session_id: sessionId, user_id: userId, role: msg.role, content: msg.content,
    meta: Object.keys(meta).length ? meta : null,
  })
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
