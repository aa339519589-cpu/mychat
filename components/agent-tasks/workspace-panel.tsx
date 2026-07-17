"use client"

import type { ButtonHTMLAttributes, ReactNode } from "react"
import {
  CheckCircle,
  ExternalLink,
  FileDiff,
  GitBranch,
  Loader2,
  RotateCcw,
  Send,
  Wrench,
  XCircle,
} from "lucide-react"
import type { AgentTaskDetail, AgentWorkspace } from "@/lib/agent/types"
import { isSafeExternalHttpUrl } from "@/lib/external-url"
import { cn } from "@/lib/utils"
import { changedFileBadge, displayedDiff, failedVerificationErrors } from "./status"
import type { DetectedCommands, GitStatusData, VerifyData, WorkspaceDiff } from "./types"
import type { WorkspaceActions } from "./use-workspace-actions"

const WORKSPACE_STATUS = {
  created: { label: "已创建", className: "text-muted-foreground" },
  cloning: { label: "克隆中", className: "text-[var(--code-accent)]" },
  ready: { label: "就绪", className: "text-emerald-400" },
  dirty: { label: "有改动", className: "text-amber-400" },
  failed: { label: "失败", className: "text-red-400" },
  cleaned: { label: "已清理", className: "text-muted-foreground" },
} as const

function PanelButton({
  children,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode }) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-md px-3 text-[11px] font-medium",
        "bg-secondary/50 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--code-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  )
}

function WorkspaceSummary({
  workspace,
  actions,
}: {
  workspace: AgentWorkspace
  actions: WorkspaceActions
}) {
  const status = WORKSPACE_STATUS[workspace.status]
  return (
    <header className="space-y-2">
      <div className="flex min-w-0 items-center justify-between gap-3">
        <h3 id="workspace-heading" className="text-xs font-semibold text-foreground">Workspace</h3>
        <span className={cn("text-[11px] font-medium", status.className)} aria-live="polite">
          {status.label}
        </span>
      </div>
      <div className="min-w-0 rounded-md bg-secondary/30 px-2.5 py-2 text-[11px] text-muted-foreground">
        <div className="truncate" title={`${workspace.repo} @ ${workspace.branch}`}>
          {workspace.repo} @ {workspace.branch}
        </div>
      </div>
      <div className="flex min-w-0 items-center gap-2 text-[11px] text-muted-foreground">
        <span>Snapshots: {actions.snapshotCount}</span>
        {actions.lastSnapshotId && (
          <span className="max-w-[140px] truncate text-muted-foreground/70" title={actions.lastSnapshotId}>
            #{actions.lastSnapshotId.slice(0, 8)}
          </span>
        )}
      </div>
    </header>
  )
}

function WorkspaceControls({ actions }: { actions: WorkspaceActions }) {
  const toggleDiff = () => {
    if (!actions.showDiff) void actions.fetchDiff()
    actions.setShowDiff(value => !value)
  }
  return (
    <div className="flex flex-wrap gap-2">
      <PanelButton
        onClick={toggleDiff}
        disabled={actions.diffLoading}
        aria-expanded={actions.showDiff}
        aria-controls="workspace-diff"
      >
        {actions.diffLoading
          ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
          : <FileDiff className="size-3.5" aria-hidden="true" />}
        {actions.diffLoading ? "加载中…" : actions.showDiff ? "隐藏 Diff" : "查看 Diff"}
      </PanelButton>
      <PanelButton onClick={actions.restore} disabled={actions.restoring}>
        <RotateCcw
          className={cn("size-3.5", actions.restoring && "animate-spin")}
          aria-hidden="true"
        />
        {actions.restoring ? "恢复中…" : "恢复 Snapshot"}
      </PanelButton>
    </div>
  )
}

function RestoreNotice({ actions }: { actions: WorkspaceActions }) {
  const result = actions.restoreResult
  if (!result) return null
  return (
    <div
      role={result.ok === false ? "alert" : "status"}
      className={cn(
        "rounded-md px-2.5 py-2 text-[11px]",
        result.ok === false ? "bg-red-400/10 text-red-400" : "bg-emerald-400/10 text-emerald-400",
      )}
    >
      {result.ok === false
        ? result.error ?? "恢复失败"
        : `恢复完成：${result.restoredFiles ?? "?"} 个文件${result.failedFiles ? `（${result.failedFiles} 失败）` : ""}`}
      {result.usedSource && (
        <span className="ml-1 text-muted-foreground">来源: {result.usedSource}</span>
      )}
    </div>
  )
}

function GitStatusPanel({ status, actions }: { status: GitStatusData | null; actions: WorkspaceActions }) {
  if (!status) return null
  if (!status.ok) {
    return <div role="alert" className="rounded-md bg-red-400/10 px-2.5 py-2 text-[11px] text-red-400">
      {status.error ?? "无法读取 Git 状态"}
    </div>
  }
  return (
    <div className="space-y-2 rounded-md bg-secondary/20 p-2.5">
      <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
        <GitBranch className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="truncate">{status.currentBranch}</span>
        {status.commitSha && <code className="ml-auto text-[10px] text-muted-foreground/70">
          {status.commitSha.slice(0, 7)}
        </code>}
      </div>
      {status.hasChanges ? (
        <div className="space-y-2">
          <div className="text-[11px] text-amber-400">{status.changedFiles?.length ?? 0} 个文件待提交</div>
          <PanelButton
            onClick={actions.publish}
            disabled={actions.publishing}
            className="bg-primary/15 text-primary hover:bg-primary/25 hover:text-primary"
          >
            <Send className={cn("size-3.5", actions.publishing && "animate-pulse")} aria-hidden="true" />
            {actions.publishing ? "发布中…" : "发布 Pull Request"}
          </PanelButton>
        </div>
      ) : <span className="text-[11px] text-muted-foreground/70">无改动</span>}
    </div>
  )
}

function PublishNotice({ actions }: { actions: WorkspaceActions }) {
  const result = actions.publishResult
  if (!result) return null
  const url = result.pr?.pullRequestUrl
  return (
    <div
      role={result.ok ? "status" : "alert"}
      className={cn(
        "rounded-md px-2.5 py-2 text-[11px]",
        result.ok ? "bg-emerald-400/10 text-emerald-400" : "bg-red-400/10 text-red-400",
      )}
    >
      {result.ok ? "已创建 Pull Request" : `发布失败${result.stage ? `（${result.stage}）` : ""}：${result.error ?? "未知错误"}`}
      {result.ok && isSafeExternalHttpUrl(url) && (
        <a href={url} target="_blank" rel="noopener noreferrer" className="ml-2 inline-flex items-center gap-1 underline">
          <ExternalLink className="size-3.5" aria-hidden="true" />打开
        </a>
      )}
    </div>
  )
}

function DetectedCommandsPanel({ commands }: { commands: DetectedCommands }) {
  const entries = [
    ["lint", commands.lintCommand],
    ["typecheck", commands.typecheckCommand],
    ["test", commands.testCommand],
    ["build", commands.buildCommand],
  ].filter((entry): entry is [string, string] => typeof entry[1] === "string")
  return (
    <div className="space-y-1 rounded-md bg-secondary/20 px-2.5 py-2 text-[11px] text-muted-foreground">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span>{commands.packageManager}</span>
        <span>{commands.framework}</span>
        <span className="text-muted-foreground/70">置信度 {commands.confidence}%</span>
      </div>
      {entries.map(([name, command]) => <div key={name} className="break-all">
        <span className="text-muted-foreground/70">{name}:</span> <code>{command}</code>
      </div>)}
    </div>
  )
}

function VerificationResult({ result }: { result: VerifyData }) {
  const errors = result.ok ? [] : failedVerificationErrors(result)
  return (
    <div
      role={result.ok ? "status" : "alert"}
      className={cn(
        "space-y-1 rounded-md px-2.5 py-2 text-[11px]",
        result.ok ? "bg-emerald-400/10 text-emerald-400" : "bg-red-400/10 text-red-400",
      )}
    >
      <div className="flex items-center gap-1.5">
        {result.ok
          ? <CheckCircle className="size-3.5" aria-hidden="true" />
          : <XCircle className="size-3.5" aria-hidden="true" />}
        <span>{result.ok ? "全部通过" : `${result.failedStep ?? "验证"} 失败`}</span>
        <span className="ml-auto text-muted-foreground/70">{result.totalDurationMs}ms</span>
      </div>
      {errors.map((error, index) => <div key={index} className="break-words text-muted-foreground">
        <code>{error.file ?? "unknown"}:{error.line ?? "?"}</code> {error.message}
      </div>)}
    </div>
  )
}

function VerificationPanel({ actions }: { actions: WorkspaceActions }) {
  const toggle = () => {
    if (!actions.showVerify) void actions.fetchCommands()
    actions.setShowVerify(value => !value)
  }
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <PanelButton onClick={toggle} aria-expanded={actions.showVerify} aria-controls="workspace-verification">
          <Wrench className="size-3.5" aria-hidden="true" />
          {actions.showVerify ? "隐藏检测" : "项目检测"}
        </PanelButton>
        <PanelButton onClick={actions.verify} disabled={actions.verifyLoading}>
          {actions.verifyLoading
            ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            : <CheckCircle className="size-3.5" aria-hidden="true" />}
          {actions.verifyLoading ? "验证中…" : "运行验证"}
        </PanelButton>
      </div>
      <div id="workspace-verification" className="space-y-2" aria-live="polite">
        {actions.showVerify && actions.detectedCmds && <DetectedCommandsPanel commands={actions.detectedCmds} />}
        {actions.verifyResult && <VerificationResult result={actions.verifyResult} />}
      </div>
    </div>
  )
}

function PullRequestLink({ detail }: { detail: AgentTaskDetail }) {
  if (!isSafeExternalHttpUrl(detail.pullRequestUrl)) return null
  return (
    <a
      href={detail.pullRequestUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="flex min-h-11 items-center gap-1.5 rounded-md bg-emerald-400/10 px-3 text-[11px] font-medium text-emerald-400 underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--code-accent)]"
    >
      <ExternalLink className="size-3.5" aria-hidden="true" />
      PR #{detail.pullRequestNumber ?? "?"}
    </a>
  )
}

function DiffPanel({ diff }: { diff: WorkspaceDiff }) {
  return (
    <div id="workspace-diff" className="space-y-2" aria-live="polite">
      {diff.hasChanges ? (
        <>
          <div className="text-[11px] text-muted-foreground">
            变更：+{diff.summary.added} ~{diff.summary.modified} -{diff.summary.deleted}
          </div>
          {diff.changedFiles.length > 0 && <div className="space-y-1">
            {diff.changedFiles.map(file => {
              const badge = changedFileBadge(file.status)
              return <div key={`${file.status}:${file.path}`} className="flex min-w-0 items-center gap-1.5 rounded bg-secondary/20 px-2 py-1 text-[11px] text-muted-foreground">
                <span className={cn("shrink-0 font-mono", badge.className)}>{badge.label}</span>
                <span className="truncate" title={file.path}>{file.path}</span>
              </div>
            })}
          </div>}
          <pre className="max-h-64 overflow-auto whitespace-pre rounded-md bg-secondary/20 px-2.5 py-2 font-mono text-[11px] text-muted-foreground select-all">
            {displayedDiff(diff.diff)}
          </pre>
        </>
      ) : <p className="text-[11px] text-muted-foreground/70">暂无代码变更</p>}
    </div>
  )
}

export function WorkspacePanel({ detail, actions }: { detail: AgentTaskDetail; actions: WorkspaceActions }) {
  const workspace = detail.workspace
  if (!workspace) return null
  const ready = workspace.status === "ready"
  return (
    <section aria-labelledby="workspace-heading" className="space-y-3" aria-busy={actions.diffLoading || actions.verifyLoading}>
      <WorkspaceSummary workspace={workspace} actions={actions} />
      {ready && <WorkspaceControls actions={actions} />}
      <RestoreNotice actions={actions} />
      <GitStatusPanel status={actions.gitStatus} actions={actions} />
      <PublishNotice actions={actions} />
      {ready && <VerificationPanel actions={actions} />}
      <PullRequestLink detail={detail} />
      {actions.showDiff && actions.wsDiff && <DiffPanel diff={actions.wsDiff} />}
    </section>
  )
}
