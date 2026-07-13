import type { VerifyData } from "./types"

export const STATUS_LABEL: Record<string, string> = {
  queued: "排队中",
  planning: "规划中",
  indexing: "索引中",
  reading: "读取中",
  editing: "编辑中",
  running: "运行中",
  testing: "测试中",
  fixing: "修复中",
  reviewing: "审查中",
  waiting_for_user: "等待用户",
  creating_pr: "创建 PR",
  deploying: "部署中",
  completed: "完成",
  failed: "失败",
  cancelled: "已取消",
}

export const STATUS_COLOR: Record<string, string> = {
  queued: "text-muted-foreground",
  planning: "text-[var(--code-accent)]",
  indexing: "text-[var(--code-accent)]",
  reading: "text-[var(--code-accent)]",
  editing: "text-[var(--code-accent)]",
  running: "text-[var(--code-accent)]",
  testing: "text-[var(--code-accent)]",
  fixing: "text-[var(--code-accent)]",
  reviewing: "text-[var(--code-accent)]",
  waiting_for_user: "text-[var(--code-accent)]",
  creating_pr: "text-[var(--code-accent)]",
  deploying: "text-[var(--code-accent)]",
  completed: "text-[var(--code-accent)]",
  failed: "text-red-400",
  cancelled: "text-muted-foreground/60",
}

export function statusLabel(status: string): string {
  return STATUS_LABEL[status] ?? status
}

export function statusColor(status: string): string {
  return STATUS_COLOR[status] ?? "text-muted-foreground"
}

export function changedFileBadge(status: string): { label: string; className?: string } {
  if (status === "added") return { label: "A", className: "text-green-400" }
  if (status === "modified") return { label: "M", className: "text-yellow-400" }
  if (status === "deleted") return { label: "D", className: "text-red-400" }
  return { label: "?" }
}

export function displayedDiff(diff: string, limit = 8_000): string {
  return diff.length > limit ? `${diff.slice(0, limit)}\n\n... (截断)` : diff
}

export function failedVerificationErrors(result: VerifyData, limit = 3) {
  return result.steps.find(step => !step.passed && !step.skipped)?.parsedErrors.errors.slice(0, limit) ?? []
}
