"use client"

import { ChevronLeft } from "lucide-react"
import type { AgentTaskDetail } from "@/lib/agent/types"
import { isSafeExternalHttpUrl } from "@/lib/external-url"
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
    <div className="flex h-full flex-col">
      <div className="flex min-h-11 items-center gap-2 border-b border-border px-2">
        <button type="button" onClick={onBack} aria-label="返回任务列表" className="inline-flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--code-accent)]">
          <ChevronLeft className="size-4" aria-hidden="true" />
        </button>
        <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-foreground">{detail.goal.slice(0, 60)}</span>
        <span className={cn("shrink-0 text-[10px]", statusColor(detail.status))}>{statusLabel(detail.status)}</span>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {detail.error && <p role="alert" className="rounded-md bg-red-400/10 px-3 py-2 text-[11px] text-red-400">{detail.error}</p>}
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
                  {toolCall.error && <span className="ml-2 truncate text-red-400">{toolCall.error}</span>}
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
                <div key={artifact.id} className="min-h-11 rounded bg-secondary/30 px-2 py-1 text-[10px] text-muted-foreground">
                  [{artifact.kind}] {artifact.title || artifact.id}
                  {isSafeExternalHttpUrl(artifact.url) && (
                    <a href={artifact.url} target="_blank" rel="noopener noreferrer" className="ml-2 inline-flex min-h-11 items-center rounded-md underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--code-accent)]" style={{ color: ACCENT }}>
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
