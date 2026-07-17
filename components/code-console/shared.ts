import type { PlanAction } from "@/lib/code-data"

export const MONO = "ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,'Courier New',monospace"
export const ACCENT = "var(--code-accent)"
export const CONTROL_FOCUS = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--code-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-background"

export type RepoItem = { name: string; full_name: string; private: boolean; description: string }
export type Overlay = null | "model" | "memory" | "resume" | "context" | "tasks"

export const COMMANDS = [
  { cmd: "/new", desc: "在当前项目内开启新对话" },
  { cmd: "/model", desc: "切换模型（快速 / 均衡 / 深度）" },
  { cmd: "/memory", desc: "查看 / 编辑本仓库的记忆" },
  { cmd: "/context", desc: "查看当前上下文用量" },
  { cmd: "/resume", desc: "恢复本仓库的历史排查" },
  { cmd: "/tasks", desc: "查看 Agent 任务列表与状态" },
] as const

export function planSummary(plan: PlanAction[]): string {
  const created = plan.filter(action => action.kind === "create_repo").length
  const written = plan.filter(action => action.kind === "write_file").length
  const deleted = plan.filter(action => action.kind === "delete_file").length
  const publishes = plan.some(action => action.kind === "enable_pages")
  const parts: string[] = []
  if (created) parts.push(`新建 ${created} 个仓库`)
  if (written) parts.push(`写入 ${written} 个文件`)
  if (deleted) parts.push(`删除 ${deleted} 个文件`)
  if (publishes) parts.push("上线")
  return parts.join(" · ") || "改动"
}
