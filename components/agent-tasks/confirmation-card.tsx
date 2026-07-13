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
      <div className="flex gap-1.5">
        <button
          onClick={actions.confirm}
          disabled={actions.confirming}
          className="flex items-center gap-1 text-[10px] rounded px-2.5 py-1 bg-yellow-400/20 hover:bg-yellow-400/30 transition-colors text-yellow-400 font-medium"
        >
          <Shield className="size-3" />
          确认继续
        </button>
        <button
          onClick={actions.reject}
          disabled={actions.confirming}
          className="flex items-center gap-1 text-[10px] rounded px-2.5 py-1 bg-secondary/50 hover:bg-secondary transition-colors text-muted-foreground"
        >
          <XCircle className="size-3" />
          拒绝
        </button>
      </div>
    </div>
  )
}
