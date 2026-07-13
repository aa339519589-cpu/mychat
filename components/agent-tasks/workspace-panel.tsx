"use client"

import { CheckCircle, ExternalLink, FileDiff, GitBranch, Loader2, RotateCcw, Send, Wrench, XCircle } from "lucide-react"
import type { AgentTaskDetail } from "@/lib/agent/types"
import { cn } from "@/lib/utils"
import { changedFileBadge, displayedDiff, failedVerificationErrors } from "./status"
import type { WorkspaceActions } from "./use-workspace-actions"

const ACCENT = "var(--code-accent)"

export function WorkspacePanel({ detail, actions }: { detail: AgentTaskDetail; actions: WorkspaceActions }) {
  const workspace = detail.workspace
  if (!workspace) return null

  return (
    <div>
      <p className="text-[10px] text-muted-foreground mb-1.5">Workspace</p>
      <div className="text-[10px] rounded bg-secondary/30 px-2 py-1 text-muted-foreground mb-2">
        {workspace.repo} @ {workspace.branch}
        {workspace.status === "ready" && <span className="ml-2 text-green-400">· ready</span>}
        {workspace.status === "dirty" && <span className="ml-2 text-yellow-400">· dirty</span>}
      </div>

      <div className="text-[10px] text-muted-foreground mb-2 flex items-center gap-2">
        <span>Snapshots: {actions.snapshotCount}</span>
        {actions.lastSnapshotId && (
          <span className="text-muted-foreground/60 truncate max-w-[120px]" title={actions.lastSnapshotId}>
            #{actions.lastSnapshotId.slice(0, 8)}
          </span>
        )}
      </div>

      {workspace.status === "ready" && (
        <div className="flex gap-1.5 mb-2">
          <button
            onClick={() => { actions.fetchDiff(); actions.setShowDiff(value => !value) }}
            disabled={actions.diffLoading}
            className="flex items-center gap-1 text-[10px] rounded px-2 py-1 bg-secondary/50 hover:bg-secondary transition-colors text-muted-foreground hover:text-foreground"
          >
            <FileDiff className="size-3" />
            {actions.diffLoading ? "加载中…" : actions.showDiff ? "隐藏 Diff" : "查看 Diff"}
          </button>
          <button
            onClick={actions.restore}
            disabled={actions.restoring}
            className="flex items-center gap-1 text-[10px] rounded px-2 py-1 bg-secondary/50 hover:bg-secondary transition-colors text-muted-foreground hover:text-foreground"
          >
            <RotateCcw className={cn("size-3", actions.restoring && "animate-spin")} />
            {actions.restoring ? "恢复中…" : "恢复上次 Snapshot"}
          </button>
        </div>
      )}

      {actions.restoreResult && (
        <div className="text-[9px] rounded bg-green-400/10 px-2 py-1 mb-2">
          <span className="text-green-400">
            恢复完成：{actions.restoreResult.restoredFiles ?? "?"} 个文件
            {actions.restoreResult.failedFiles ? `（${actions.restoreResult.failedFiles} 失败）` : ""}
          </span>
          <span className="text-muted-foreground/60 ml-1">
            来源: {actions.restoreResult.usedSource ?? "unknown"}
          </span>
        </div>
      )}

      {actions.gitStatus?.ok && (
        <div className="mb-2 p-1.5 rounded bg-secondary/20">
          <div className="flex items-center gap-1 text-[9px] text-muted-foreground mb-1">
            <GitBranch className="size-3" />
            <span>{actions.gitStatus.currentBranch}</span>
            {actions.gitStatus.commitSha && (
              <span className="text-muted-foreground/50">{actions.gitStatus.commitSha.slice(0, 7)}</span>
            )}
          </div>
          {actions.gitStatus.hasChanges ? (
            <div className="space-y-1">
              <div className="text-[9px] text-yellow-400">
                {actions.gitStatus.changedFiles?.length ?? 0} 个文件待提交
              </div>
              <button
                onClick={actions.publish}
                disabled={actions.publishing}
                className="flex items-center gap-1 text-[10px] rounded px-2 py-1 bg-primary/20 hover:bg-primary/30 transition-colors text-primary"
              >
                <Send className={cn("size-3", actions.publishing && "animate-pulse")} />
                {actions.publishing ? "发布中…" : "发布为 Pull Request"}
              </button>
            </div>
          ) : (
            <span className="text-[9px] text-muted-foreground/50">无改动</span>
          )}
        </div>
      )}

      {actions.publishResult && (
        <div className={cn("text-[9px] rounded px-2 py-1 mb-2", actions.publishResult.ok ? "bg-green-400/10" : "bg-red-400/10")}>
          {actions.publishResult.ok ? (
            <span className="text-green-400">
              已创建 PR！
              {actions.publishResult.pr?.pullRequestUrl && (
                <a href={actions.publishResult.pr.pullRequestUrl} target="_blank" rel="noreferrer" className="ml-1 underline" style={{ color: ACCENT }}>
                  <ExternalLink className="size-3 inline" /> 打开
                </a>
              )}
            </span>
          ) : (
            <span className="text-red-400">
              发布失败{actions.publishResult.stage ? `（${actions.publishResult.stage}）` : ""}：{actions.publishResult.error}
            </span>
          )}
        </div>
      )}

      {workspace.status === "ready" && (
        <div className="mb-2 space-y-1">
          <div className="flex gap-1.5">
            <button
              onClick={() => { void actions.fetchCommands(); actions.setShowVerify(value => !value) }}
              className="flex items-center gap-1 text-[10px] rounded px-2 py-1 bg-secondary/50 hover:bg-secondary transition-colors text-muted-foreground hover:text-foreground"
            >
              <Wrench className="size-3" />
              {actions.showVerify ? "隐藏验证" : "项目检测 & 验证"}
            </button>
            <button
              onClick={actions.verify}
              disabled={actions.verifyLoading}
              className="flex items-center gap-1 text-[10px] rounded px-2 py-1 bg-secondary/50 hover:bg-secondary transition-colors text-muted-foreground hover:text-foreground"
            >
              {actions.verifyLoading ? <Loader2 className="size-3 animate-spin" /> : <CheckCircle className="size-3" />}
              {actions.verifyLoading ? "验证中" : "运行验证"}
            </button>
          </div>

          {actions.showVerify && actions.detectedCmds && (
            <div className="text-[9px] rounded bg-secondary/20 px-2 py-1 text-muted-foreground">
              <div className="flex items-center gap-2">
                <span>{actions.detectedCmds.packageManager}</span>
                <span>{actions.detectedCmds.framework}</span>
                <span className="text-muted-foreground/50">conf: {actions.detectedCmds.confidence}%</span>
              </div>
              {actions.detectedCmds.lintCommand && <div>lint: {actions.detectedCmds.lintCommand}</div>}
              {actions.detectedCmds.typecheckCommand && <div>typecheck: {actions.detectedCmds.typecheckCommand}</div>}
              {actions.detectedCmds.testCommand && <div>test: {actions.detectedCmds.testCommand}</div>}
              {actions.detectedCmds.buildCommand && <div>build: {actions.detectedCmds.buildCommand}</div>}
            </div>
          )}

          {actions.verifyResult && (
            <div className={cn("text-[9px] rounded px-2 py-1", actions.verifyResult.ok ? "bg-green-400/10 text-green-400" : "bg-red-400/10 text-red-400")}>
              <div className="flex items-center gap-1">
                {actions.verifyResult.ok ? <CheckCircle className="size-3" /> : <XCircle className="size-3" />}
                <span>{actions.verifyResult.ok ? "全部通过" : `${actions.verifyResult.failedStep ?? "?"} 失败`}</span>
                <span className="text-muted-foreground/50">{actions.verifyResult.totalDurationMs}ms</span>
              </div>
              {!actions.verifyResult.ok && failedVerificationErrors(actions.verifyResult).map((error, index) => (
                <div key={index} className="mt-0.5 truncate text-muted-foreground">
                  {error.file}:{error.line} {error.message.slice(0, 80)}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {detail.pullRequestUrl && (
        <div className="text-[9px] rounded bg-green-400/10 px-2 py-1 mb-2">
          <a href={detail.pullRequestUrl} target="_blank" rel="noreferrer" className="text-green-400 underline flex items-center gap-1">
            <ExternalLink className="size-3" />
            PR #{detail.pullRequestNumber ?? "?"}
          </a>
        </div>
      )}

      {actions.showDiff && actions.wsDiff && (
        <div className="mt-2 space-y-1.5">
          {actions.wsDiff.hasChanges ? (
            <>
              <div className="text-[9px] text-muted-foreground/70">
                变更：+{actions.wsDiff.summary.added} ~{actions.wsDiff.summary.modified} -{actions.wsDiff.summary.deleted}
              </div>
              {actions.wsDiff.changedFiles.length > 0 && (
                <div className="space-y-0.5">
                  {actions.wsDiff.changedFiles.map((file, index) => {
                    const badge = changedFileBadge(file.status)
                    return (
                      <div key={index} className="text-[9px] rounded bg-secondary/20 px-1.5 py-0.5 text-muted-foreground flex items-center gap-1">
                        <span className={cn("shrink-0", badge.className)}>{badge.label}</span>
                        <span className="truncate">{file.path}</span>
                      </div>
                    )
                  })}
                </div>
              )}
              <pre className="text-[9px] rounded bg-secondary/20 px-2 py-1.5 text-muted-foreground max-h-64 overflow-y-auto overflow-x-auto whitespace-pre select-all">
                {displayedDiff(actions.wsDiff.diff)}
              </pre>
            </>
          ) : (
            <p className="text-[10px] text-muted-foreground/60">暂无代码变更</p>
          )}
        </div>
      )}
    </div>
  )
}
