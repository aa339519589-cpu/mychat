"use client"

import { Loader2, RefreshCw, X } from "lucide-react"
import type { AgentTask } from "@/lib/agent/types"
import { cn } from "@/lib/utils"
import { statusColor, statusLabel } from "./status"

type TaskListProps = {
  tasks: AgentTask[] | null
  loading: boolean
  error: string | null
  onClose?: () => void
  onRefresh: () => void
  onSelect: (taskId: string) => void
}

export function TaskList({ tasks, loading, error, onClose, onRefresh, onSelect }: TaskListProps) {
  return (
    <div className="flex flex-col h-full">
      <div className="flex min-h-11 items-center gap-2 border-b border-border px-4">
        <span className="text-[11px] font-medium text-foreground">Agent Tasks</span>
        <button type="button" onClick={onRefresh} aria-label="刷新任务" className="ml-auto inline-flex size-11 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--code-accent)]">
          <RefreshCw className={cn("size-3.5", loading && "animate-spin")} aria-hidden="true" />
        </button>
        {onClose && <button type="button" onClick={onClose} aria-label="关闭任务" className="inline-flex size-11 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--code-accent)]">
          <X className="size-4" aria-hidden="true" />
        </button>}
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading && tasks === null && (
          <div role="status" aria-label="正在载入 Agent 任务" className="flex justify-center py-10 text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          </div>
        )}
        {error && <p role="alert" className="px-4 py-3 text-[11px] text-red-400">{error}</p>}
        {tasks?.length === 0 && (
          <p className="px-4 py-8 text-center text-[11px] text-muted-foreground">暂无 Agent 任务</p>
        )}
        {tasks?.map(task => (
          <button
            type="button"
            key={task.id}
            onClick={() => onSelect(task.id)}
            className="min-h-11 w-full border-b border-border/30 px-4 py-2.5 text-left transition-colors hover:bg-secondary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--code-accent)]"
          >
            <div className="flex items-center gap-2">
              <span className={cn("shrink-0 text-[9px]", statusColor(task.status))}>
                {statusLabel(task.status)}
              </span>
              {task.repo && <span className="text-[9px] text-muted-foreground/70">{task.repo}</span>}
              <span className="text-[9px] text-muted-foreground/50 ml-auto">
                {new Date(task.createdAt).toLocaleDateString("zh-CN", {
                  month: "short",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
            </div>
            <p className="text-[11px] text-foreground/80 truncate mt-0.5">{task.goal}</p>
            {task.error && <p className="text-[10px] text-red-400/80 truncate mt-0.5">{task.error}</p>}
          </button>
        ))}
      </div>
    </div>
  )
}
