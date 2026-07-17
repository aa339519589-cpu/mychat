"use client"

import { AlertTriangle, Shield, XCircle } from "lucide-react"
import type { WorkspaceActions } from "./use-workspace-actions"

export function ConfirmationCard({ actions }: { actions: WorkspaceActions }) {
  const confirmation = actions.pendingConf
  if (!confirmation) return null

  return (
    <div className="rounded-lg border border-yellow-400/30 bg-yellow-400/5 p-2.5">
      <div className="flex items-center gap-1.5 text-[10px] font-medium text-yellow-400 mb-1">
        <AlertTriangle className="size-3.5" />
        <span>需要确认</span>
        <span className="ml-auto text-[9px] px-1 py-0.5 rounded bg-yellow-400/10">
          {confirmation.riskLevel}
        </span>
      </div>
      <p className="text-[10px] text-foreground/80 mb-1">{confirmation.title}</p>
      <p className="text-[9px] text-muted-foreground mb-2">{confirmation.reason}</p>
      {confirmation.files.length > 0 && (
        <div className="text-[9px] text-muted-foreground mb-2 max-h-20 overflow-y-auto">
          {confirmation.files.map((file, index) => <div key={index} className="truncate">{file}</div>)}
        </div>
      )}
      <div className="flex flex-col gap-2 min-[360px]:flex-row">
        <button
          type="button"
          onClick={actions.confirm}
          disabled={actions.confirming}
          className="inline-flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-md bg-yellow-400/20 px-3 text-[10px] font-medium text-yellow-400 transition-colors hover:bg-yellow-400/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow-400 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Shield className="size-3.5" aria-hidden="true" />
          确认继续
        </button>
        <button
          type="button"
          onClick={actions.reject}
          disabled={actions.confirming}
          className="inline-flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-md bg-secondary/50 px-3 text-[10px] text-muted-foreground transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--code-accent)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          <XCircle className="size-3.5" aria-hidden="true" />
          拒绝
        </button>
      </div>
    </div>
  )
}
