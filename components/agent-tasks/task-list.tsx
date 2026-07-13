"use client"

import { Loader2, RefreshCw, X } from "lucide-react"
import type { AgentTask } from "@/lib/agent/types"
import { cn } from "@/lib/utils"
import { statusColor, statusLabel } from "./status"

type TaskListProps = {
  tasks: AgentTask[] | null
  loading: boolean
  error: string | null
  onClose: () => void
  onRefresh: () => void
  onSelect: (taskId: string) => void
}

export function TaskList({ tasks, loading, error, onClose, onRefresh, onSelect }: TaskListProps) {
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border">
        <span className="text-[11px] font-medium text-foreground">Agent Tasks</span>
        <button onClick={onRefresh} className="ml-auto text-muted-foreground hover:text-foreground">
          <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
        </button>
        <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
          <X className="size-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading && tasks === null && (
          <div className="flex justify-center py-10 text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
          </div>
        )}
        {error && <p className="px-4 py-3 text-[11px] text-red-400">{error}</p>}
        {tasks?.length === 0 && (
          <p className="px-4 py-8 text-center text-[11px] text-muted-foreground">暂无 Agent 任务</p>
        )}
        {tasks?.map(task => (
          <button
            key={task.id}
            onClick={() => onSelect(task.id)}
            className="w-full text-left px-4 py-2.5 border-b border-border/30 transition-colors hover:bg-secondary/40"
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
