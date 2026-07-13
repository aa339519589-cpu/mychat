"use client"

import { ChevronLeft } from "lucide-react"
import type { AgentTaskDetail } from "@/lib/agent/types"
import { cn } from "@/lib/utils"
import { ConfirmationCard } from "./confirmation-card"
import { statusColor, statusLabel } from "./status"
import type { WorkspaceActions } from "./use-workspace-actions"
import { WorkspacePanel } from "./workspace-panel"

const ACCENT = "var(--code-accent)"

export function TaskDetail({
  detail,
  actions,
  onBack,
}: {
  detail: AgentTaskDetail
  actions: WorkspaceActions
  onBack: () => void
}) {
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border">
        <button onClick={onBack} className="text-muted-foreground hover:text-foreground">
          <ChevronLeft className="size-4" />
        </button>
        <span className="text-[11px] font-medium text-foreground truncate flex-1">{detail.goal.slice(0, 60)}</span>
        <span className={cn("text-[10px]", statusColor(detail.status))}>{statusLabel(detail.status)}</span>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {detail.steps.length > 0 && (
          <div>
            <p className="text-[10px] text-muted-foreground mb-1.5">执行步骤</p>
            <div className="space-y-0.5">
              {detail.steps.map(step => (
                <div key={step.id} className="flex items-start gap-2 text-[10px]">
                  <span className={cn("shrink-0 mt-0.5", statusColor(step.kind === "error" ? "failed" : "completed"))}>·</span>
                  <span className="text-muted-foreground">{step.label || step.kind}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {detail.toolCalls.length > 0 && (
          <div>
            <p className="text-[10px] text-muted-foreground mb-1.5">工具调用</p>
            <div className="space-y-1">
              {detail.toolCalls.map(toolCall => (
                <div key={toolCall.id} className="flex items-center gap-2 text-[10px] rounded bg-secondary/30 px-2 py-1">
                  <span className={cn(
                    "shrink-0",
                    statusColor(toolCall.status === "success" ? "completed" : toolCall.status === "error" ? "failed" : "running"),
                  )}>·</span>
                  <span className="font-medium text-foreground/80">{toolCall.toolName}</span>
                  {toolCall.durationMs != null && (
                    <span className="text-muted-foreground/60 ml-auto">{toolCall.durationMs}ms</span>
                  )}
                  {toolCall.error && <span className="text-red-400 truncate ml-2">{toolCall.error}</span>}
                </div>
              ))}
            </div>
          </div>
        )}

        <ConfirmationCard actions={actions} />
        <WorkspacePanel detail={detail} actions={actions} />

        {detail.artifacts.length > 0 && (
          <div>
            <p className="text-[10px] text-muted-foreground mb-1.5">产物</p>
            <div className="space-y-1">
              {detail.artifacts.map(artifact => (
                <div key={artifact.id} className="text-[10px] rounded bg-secondary/30 px-2 py-1 text-muted-foreground">
                  [{artifact.kind}] {artifact.title || artifact.id}
                  {artifact.url && (
                    <a href={artifact.url} target="_blank" rel="noreferrer" className="ml-2 underline" style={{ color: ACCENT }}>
                      打开
                    </a>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
