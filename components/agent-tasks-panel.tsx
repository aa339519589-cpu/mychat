"use client"

import { useEffect, useState } from "react"
import { X, ChevronLeft, Loader2, RefreshCw, FileDiff, RotateCcw, GitBranch, ExternalLink, Send, CheckCircle, XCircle, Wrench, AlertTriangle, Shield } from "lucide-react"
import type { AgentTask, AgentTaskDetail } from "@/lib/agent/types"
import { cn } from "@/lib/utils"

const MONO = "ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,'Courier New',monospace"
const ACCENT = "var(--code-accent)"

type WorkspaceDiff = {
  diff: string
  changedFiles: { path: string; status: string }[]
  summary: { added: number; modified: number; deleted: number }
  hasChanges: boolean
}

type RestoreResponse = {
  ok: boolean
  error?: string
  restoredFiles?: number
  failedFiles?: number
  usedSource?: "local_patch" | "artifact_patch" | "git_fallback" | "none"
  snapshotId?: string
  diff?: string
  changedFiles?: { path: string; status: string }[]
}

type SnapshotListResponse = {
  ok: boolean
  snapshots?: { snapshotId: string; changedFiles: string[]; createdAt: string; reason: string; storage: string; restorable: boolean }[]
}

const STATUS_LABEL: Record<string, string> = {
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

const STATUS_COLOR: Record<string, string> = {
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

// ── 任务列表 ──

export function AgentTasksPanel({ onClose }: { onClose: () => void }) {
  const [tasks, setTasks] = useState<AgentTask[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [detail, setDetail] = useState<AgentTaskDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Workspace diff
  const [wsDiff, setWsDiff] = useState<WorkspaceDiff | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const [showDiff, setShowDiff] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [restoreResult, setRestoreResult] = useState<RestoreResponse | null>(null)
  const [snapshotCount, setSnapshotCount] = useState(0)
  const [lastSnapshotId, setLastSnapshotId] = useState<string | null>(null)

  // Git
  type GitStatusData = { ok: boolean; currentBranch?: string; changedFiles?: { path: string; status: string }[]; hasChanges?: boolean; commitSha?: string; error?: string }
  const [gitStatus, setGitStatus] = useState<GitStatusData | null>(null)
  const [publishing, setPublishing] = useState(false)
  const [publishResult, setPublishResult] = useState<{ ok: boolean; pr?: { pullRequestUrl?: string }; error?: string; stage?: string } | null>(null)

  // Verification
  type DetectedCmds = { packageManager: string; framework: string; confidence: number; installCommand: string | null; lintCommand: string | null; typecheckCommand: string | null; testCommand: string | null; buildCommand: string | null; notes: string[] }
  type VerifyStep = { name: string; command: string | null; skipped: boolean; skipReason?: string; passed: boolean; durationMs: number; parsedErrors: { totalErrors: number; totalWarnings: number; summary: string; errors: { file: string | null; line: number | null; message: string; severity: string }[] } }
  type VerifyData = { ok: boolean; steps: VerifyStep[]; failedStep: string | null; totalDurationMs: number; summary: string }
  const [detectedCmds, setDetectedCmds] = useState<DetectedCmds | null>(null)
  const [verifyResult, setVerifyResult] = useState<VerifyData | null>(null)
  const [verifyLoading, setVerifyLoading] = useState(false)
  const [showVerify, setShowVerify] = useState(false)

  // Confirmation
  type PendingConfirmation = { id: string; operation: string; riskLevel: string; title: string; reason: string; files: string[]; status: string }
  const [pendingConf, setPendingConf] = useState<PendingConfirmation | null>(null)
  const [confirming, setConfirming] = useState(false)

  const fetchList = async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch("/api/agent/tasks")
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "请求失败")
      setTasks(await res.json())
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败")
    } finally {
      setLoading(false)
    }
  }

  const fetchDetail = async (taskId: string) => {
    setError(null)
    try {
      const res = await fetch(`/api/agent/tasks/${taskId}`)
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "请求失败")
      setDetail(await res.json())
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载详情失败")
    }
  }

  useEffect(() => { fetchList() }, [])

  const fetchDiff = async (taskId: string) => {
    setDiffLoading(true)
    try {
      const [diffRes, snapRes, gitRes] = await Promise.all([
        fetch(`/api/agent/tasks/${taskId}/workspace/diff`),
        fetch(`/api/agent/tasks/${taskId}/workspace/snapshot`),
        fetch(`/api/agent/tasks/${taskId}/workspace/git`),
      ])
      if (diffRes.ok) setWsDiff(await diffRes.json())
      if (snapRes.ok) {
        const snapData: SnapshotListResponse = await snapRes.json()
        if (snapData.snapshots) {
          setSnapshotCount(snapData.snapshots.length)
          setLastSnapshotId(snapData.snapshots[0]?.snapshotId ?? null)
        }
      }
      if (gitRes.ok) setGitStatus(await gitRes.json())
    } catch { /* ignore */ }
    finally { setDiffLoading(false) }
  }

  const fetchCommands = async (taskId: string) => {
    try {
      const res = await fetch(`/api/agent/tasks/${taskId}/workspace/commands`)
      if (res.ok) setDetectedCmds(await res.json())
    } catch {}
  }

  const handleVerify = async (taskId: string) => {
    setVerifyLoading(true)
    setVerifyResult(null)
    try {
      const res = await fetch(`/api/agent/tasks/${taskId}/workspace/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ install: false }),
      })
      const data = await res.json()
      setVerifyResult(data)
    } catch {
      setVerifyResult({ ok: false, steps: [], failedStep: null, totalDurationMs: 0, summary: "请求失败" })
    } finally {
      setVerifyLoading(false)
    }
  }

  const fetchConfirmation = async (taskId: string) => {
    try {
      const res = await fetch(`/api/agent/tasks/${taskId}/confirm`)
      if (res.ok) {
        const data = await res.json()
        if (data && data.status === "pending") setPendingConf(data)
        else setPendingConf(null)
      }
    } catch { setPendingConf(null) }
  }

  const handleConfirm = async (taskId: string, confirmationId: string) => {
    setConfirming(true)
    try {
      const res = await fetch(`/api/agent/tasks/${taskId}/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "confirm", confirmationId }),
      })
      if (res.ok) { setPendingConf(null); fetchDiff(taskId) }
    } catch {}
    finally { setConfirming(false) }
  }

  const handleReject = async (taskId: string, confirmationId: string) => {
    setConfirming(true)
    try {
      const res = await fetch(`/api/agent/tasks/${taskId}/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reject", confirmationId }),
      })
      if (res.ok) { setPendingConf(null); fetchDiff(taskId) }
    } catch {}
    finally { setConfirming(false) }
  }

  const handlePublish = async (taskId: string) => {
    if (!gitStatus?.hasChanges) { alert("没有可发布的改动"); return }
    if (!confirm("将 commit → push → 创建 Pull Request，确定发布？")) return
    setPublishing(true)
    setPublishResult(null)
    try {
      const res = await fetch(`/api/agent/tasks/${taskId}/workspace/git`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "publish" }),
      })
      const data = await res.json()
      setPublishResult(data)
      if (data.ok) {
        fetchDiff(taskId)
        setGitStatus(null)  // refresh
      }
    } catch {
      setPublishResult({ ok: false, error: "发布请求失败" })
    } finally {
      setPublishing(false)
    }
  }

  const handleRestore = async (taskId: string) => {
    if (!confirm("确定要恢复最近一次 snapshot？所有未保存的修改将丢失。")) return
    setRestoring(true)
    setRestoreResult(null)
    try {
      const res = await fetch(`/api/agent/tasks/${taskId}/workspace/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ useLast: true }),
      })
      const data: RestoreResponse = await res.json()
      if (res.ok) {
        setRestoreResult(data)
        setWsDiff(null)
        setShowDiff(false)
        fetchDiff(taskId)  // refresh
      } else {
        setRestoreResult(data)
        alert(data.error ?? "恢复失败")
      }
    } catch {
      alert("恢复失败")
    } finally {
      setRestoring(false)
    }
  }

  useEffect(() => {
    if (selected && (detail?.workspace?.status === "ready" || detail?.workspace?.status === "dirty")) {
      fetchDiff(selected)
      fetchConfirmation(selected)
    } else {
      setWsDiff(null)
      setShowDiff(false)
      setPendingConf(null)
    }
  }, [selected, detail?.workspace?.status])

  // Detail view
  if (selected && detail) {
    return (
      <div className="flex flex-col h-full" style={{ fontFamily: MONO }}>
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border">
          <button onClick={() => { setSelected(null); setDetail(null) }} className="text-muted-foreground hover:text-foreground">
            <ChevronLeft className="size-4" />
          </button>
          <span className="text-[11px] font-medium text-foreground truncate flex-1">{detail.goal.slice(0, 60)}</span>
          <span className={cn("text-[10px]", STATUS_COLOR[detail.status] ?? "text-muted-foreground")}>
            {STATUS_LABEL[detail.status] ?? detail.status}
          </span>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
          {/* Steps */}
          {detail.steps.length > 0 && (
            <div>
              <p className="text-[10px] text-muted-foreground mb-1.5">执行步骤</p>
              <div className="space-y-0.5">
                {detail.steps.map(s => (
                  <div key={s.id} className="flex items-start gap-2 text-[10px]">
                    <span className={cn("shrink-0 mt-0.5", STATUS_COLOR[s.kind === "error" ? "failed" : "completed"])}>·</span>
                    <span className="text-muted-foreground">{s.label || s.kind}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Tool calls */}
          {detail.toolCalls.length > 0 && (
            <div>
              <p className="text-[10px] text-muted-foreground mb-1.5">工具调用</p>
              <div className="space-y-1">
                {detail.toolCalls.map(tc => (
                  <div key={tc.id} className="flex items-center gap-2 text-[10px] rounded bg-secondary/30 px-2 py-1">
                    <span className={cn("shrink-0", STATUS_COLOR[tc.status === "success" ? "completed" : tc.status === "error" ? "failed" : "running"])}>·</span>
                    <span className="font-medium text-foreground/80">{tc.toolName}</span>
                    {tc.durationMs != null && <span className="text-muted-foreground/60 ml-auto">{tc.durationMs}ms</span>}
                    {tc.error && <span className="text-red-400 truncate ml-2">{tc.error}</span>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Confirmation card */}
          {pendingConf && (
            <div className="rounded-lg border border-yellow-400/30 bg-yellow-400/5 p-2.5">
              <div className="flex items-center gap-1.5 text-[10px] font-medium text-yellow-400 mb-1">
                <AlertTriangle className="size-3.5" />
                <span>需要确认</span>
                <span className="ml-auto text-[9px] px-1 py-0.5 rounded bg-yellow-400/10">{pendingConf.riskLevel}</span>
              </div>
              <p className="text-[10px] text-foreground/80 mb-1">{pendingConf.title}</p>
              <p className="text-[9px] text-muted-foreground mb-2">{pendingConf.reason}</p>
              {pendingConf.files.length > 0 && (
                <div className="text-[9px] text-muted-foreground mb-2 max-h-20 overflow-y-auto">
                  {pendingConf.files.map((f, i) => <div key={i} className="truncate">{f}</div>)}
                </div>
              )}
              <div className="flex gap-1.5">
                <button
                  onClick={() => handleConfirm(selected!, pendingConf.id)}
                  disabled={confirming}
                  className="flex items-center gap-1 text-[10px] rounded px-2.5 py-1 bg-yellow-400/20 hover:bg-yellow-400/30 transition-colors text-yellow-400 font-medium"
                >
                  <Shield className="size-3" />
                  确认继续
                </button>
                <button
                  onClick={() => handleReject(selected!, pendingConf.id)}
                  disabled={confirming}
                  className="flex items-center gap-1 text-[10px] rounded px-2.5 py-1 bg-secondary/50 hover:bg-secondary transition-colors text-muted-foreground"
                >
                  <XCircle className="size-3" />
                  拒绝
                </button>
              </div>
            </div>
          )}

          {/* Workspace */}
          {detail.workspace && (
            <div>
              <p className="text-[10px] text-muted-foreground mb-1.5">Workspace</p>
              <div className="text-[10px] rounded bg-secondary/30 px-2 py-1 text-muted-foreground mb-2">
                {detail.workspace.repo} @ {detail.workspace.branch}
                {detail.workspace.status === "ready" && (
                  <span className="ml-2 text-green-400">· ready</span>
                )}
                {detail.workspace.status === "dirty" && (
                  <span className="ml-2 text-yellow-400">· dirty</span>
                )}
              </div>

              {/* Snapshot 信息 */}
              <div className="text-[10px] text-muted-foreground mb-2 flex items-center gap-2">
                <span>Snapshots: {snapshotCount}</span>
                {lastSnapshotId && (
                  <span className="text-muted-foreground/60 truncate max-w-[120px]" title={lastSnapshotId}>
                    #{lastSnapshotId.slice(0, 8)}
                  </span>
                )}
              </div>

              {/* Diff & Restore 操作 */}
              {detail.workspace.status === "ready" && (
                <div className="flex gap-1.5 mb-2">
                  <button
                    onClick={() => { fetchDiff(selected!); setShowDiff(v => !v) }}
                    disabled={diffLoading}
                    className="flex items-center gap-1 text-[10px] rounded px-2 py-1 bg-secondary/50 hover:bg-secondary transition-colors text-muted-foreground hover:text-foreground"
                  >
                    <FileDiff className="size-3" />
                    {diffLoading ? "加载中…" : showDiff ? "隐藏 Diff" : "查看 Diff"}
                  </button>
                  <button
                    onClick={() => handleRestore(selected!)}
                    disabled={restoring}
                    className="flex items-center gap-1 text-[10px] rounded px-2 py-1 bg-secondary/50 hover:bg-secondary transition-colors text-muted-foreground hover:text-foreground"
                  >
                    <RotateCcw className={cn("size-3", restoring && "animate-spin")} />
                    {restoring ? "恢复中…" : "恢复上次 Snapshot"}
                  </button>
                </div>
              )}

              {/* Restore 结果 */}
              {restoreResult && (
                <div className="text-[9px] rounded bg-green-400/10 px-2 py-1 mb-2">
                  <span className="text-green-400">
                    恢复完成：{restoreResult.restoredFiles ?? "?"} 个文件
                    {restoreResult.failedFiles ? `（${restoreResult.failedFiles} 失败）` : ""}
                  </span>
                  <span className="text-muted-foreground/60 ml-1">来源: {restoreResult.usedSource ?? "unknown"}</span>
                </div>
              )}

              {/* Git status + Publish */}
              {gitStatus && gitStatus.ok && (
                <div className="mb-2 p-1.5 rounded bg-secondary/20">
                  <div className="flex items-center gap-1 text-[9px] text-muted-foreground mb-1">
                    <GitBranch className="size-3" />
                    <span>{gitStatus.currentBranch}</span>
                    {gitStatus.commitSha && (
                      <span className="text-muted-foreground/50">{gitStatus.commitSha.slice(0, 7)}</span>
                    )}
                  </div>
                  {gitStatus.hasChanges ? (
                    <div className="space-y-1">
                      <div className="text-[9px] text-yellow-400">
                        {gitStatus.changedFiles?.length ?? 0} 个文件待提交
                      </div>
                      <button
                        onClick={() => handlePublish(selected!)}
                        disabled={publishing}
                        className="flex items-center gap-1 text-[10px] rounded px-2 py-1 bg-primary/20 hover:bg-primary/30 transition-colors text-primary"
                      >
                        <Send className={cn("size-3", publishing && "animate-pulse")} />
                        {publishing ? "发布中…" : "发布为 Pull Request"}
                      </button>
                    </div>
                  ) : (
                    <span className="text-[9px] text-muted-foreground/50">无改动</span>
                  )}
                </div>
              )}

              {/* Publish 结果 */}
              {publishResult && (
                <div className={cn("text-[9px] rounded px-2 py-1 mb-2", publishResult.ok ? "bg-green-400/10" : "bg-red-400/10")}>
                  {publishResult.ok ? (
                    <span className="text-green-400">
                      已创建 PR！
                      {publishResult.pr?.pullRequestUrl && (
                        <a href={publishResult.pr.pullRequestUrl} target="_blank" rel="noreferrer" className="ml-1 underline" style={{ color: ACCENT }}>
                          <ExternalLink className="size-3 inline" /> 打开
                        </a>
                      )}
                    </span>
                  ) : (
                    <span className="text-red-400">
                      发布失败{publishResult.stage ? `（${publishResult.stage}）` : ""}：{publishResult.error}
                    </span>
                  )}
                </div>
              )}

              {/* Verify & Fix-loop */}
              {detail.workspace.status === "ready" && (
                <div className="mb-2 space-y-1">
                  <div className="flex gap-1.5">
                    <button
                      onClick={() => { fetchCommands(selected!); setShowVerify(v => !v) }}
                      className="flex items-center gap-1 text-[10px] rounded px-2 py-1 bg-secondary/50 hover:bg-secondary transition-colors text-muted-foreground hover:text-foreground"
                    >
                      <Wrench className="size-3" />
                      {showVerify ? "隐藏验证" : "项目检测 & 验证"}
                    </button>
                    <button
                      onClick={() => handleVerify(selected!)}
                      disabled={verifyLoading}
                      className="flex items-center gap-1 text-[10px] rounded px-2 py-1 bg-secondary/50 hover:bg-secondary transition-colors text-muted-foreground hover:text-foreground"
                    >
                      {verifyLoading ? <Loader2 className="size-3 animate-spin" /> : <CheckCircle className="size-3" />}
                      {verifyLoading ? "验证中" : "运行验证"}
                    </button>
                  </div>

                  {/* Detected commands */}
                  {showVerify && detectedCmds && (
                    <div className="text-[9px] rounded bg-secondary/20 px-2 py-1 text-muted-foreground">
                      <div className="flex items-center gap-2">
                        <span>{detectedCmds.packageManager}</span>
                        <span>{detectedCmds.framework}</span>
                        <span className="text-muted-foreground/50">conf: {detectedCmds.confidence}%</span>
                      </div>
                      {detectedCmds.lintCommand && <div>lint: {detectedCmds.lintCommand}</div>}
                      {detectedCmds.typecheckCommand && <div>typecheck: {detectedCmds.typecheckCommand}</div>}
                      {detectedCmds.testCommand && <div>test: {detectedCmds.testCommand}</div>}
                      {detectedCmds.buildCommand && <div>build: {detectedCmds.buildCommand}</div>}
                    </div>
                  )}

                  {/* Verify result */}
                  {verifyResult && (
                    <div className={cn("text-[9px] rounded px-2 py-1", verifyResult.ok ? "bg-green-400/10 text-green-400" : "bg-red-400/10 text-red-400")}>
                      <div className="flex items-center gap-1">
                        {verifyResult.ok ? <CheckCircle className="size-3" /> : <XCircle className="size-3" />}
                        <span>{verifyResult.ok ? "全部通过" : `${verifyResult.failedStep ?? "?"} 失败`}</span>
                        <span className="text-muted-foreground/50">{verifyResult.totalDurationMs}ms</span>
                      </div>
                      {!verifyResult.ok && verifyResult.steps.find(s => !s.passed && !s.skipped)?.parsedErrors.errors.slice(0, 3).map((e, i) => (
                        <div key={i} className="mt-0.5 truncate text-muted-foreground">{e.file}:{e.line} {e.message.slice(0, 80)}</div>
                      ))}
                    </div>
                  )}

                </div>
              )}

              {/* PR link from task */}
              {detail.pullRequestUrl && (
                <div className="text-[9px] rounded bg-green-400/10 px-2 py-1 mb-2">
                  <a href={detail.pullRequestUrl} target="_blank" rel="noreferrer" className="text-green-400 underline flex items-center gap-1">
                    <ExternalLink className="size-3" />
                    PR #{detail.pullRequestNumber ?? "?"}
                  </a>
                </div>
              )}

              {/* Diff 内容 */}
              {showDiff && wsDiff && (
                <div className="mt-2 space-y-1.5">
                  {wsDiff.hasChanges ? (
                    <>
                      {/* 变更摘要 */}
                      <div className="text-[9px] text-muted-foreground/70">
                        变更：+{wsDiff.summary.added} ~{wsDiff.summary.modified} -{wsDiff.summary.deleted}
                      </div>
                      {/* 变更文件列表 */}
                      {wsDiff.changedFiles.length > 0 && (
                        <div className="space-y-0.5">
                          {wsDiff.changedFiles.map((f, i) => (
                            <div key={i} className="text-[9px] rounded bg-secondary/20 px-1.5 py-0.5 text-muted-foreground flex items-center gap-1">
                              <span className={cn(
                                "shrink-0",
                                f.status === "added" && "text-green-400",
                                f.status === "modified" && "text-yellow-400",
                                f.status === "deleted" && "text-red-400",
                              )}>
                                {f.status === "added" ? "A" : f.status === "modified" ? "M" : f.status === "deleted" ? "D" : "?"}
                              </span>
                              <span className="truncate">{f.path}</span>
                            </div>
                          ))}
                        </div>
                      )}
                      {/* Diff 内容 */}
                      <pre className="text-[9px] rounded bg-secondary/20 px-2 py-1.5 text-muted-foreground max-h-64 overflow-y-auto overflow-x-auto whitespace-pre select-all">
                        {wsDiff.diff.slice(0, 8000)}
                        {wsDiff.diff.length > 8000 && "\n\n... (截断)"}
                      </pre>
                    </>
                  ) : (
                    <p className="text-[10px] text-muted-foreground/60">暂无代码变更</p>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Artifacts */}
          {detail.artifacts.length > 0 && (
            <div>
              <p className="text-[10px] text-muted-foreground mb-1.5">产物</p>
              <div className="space-y-1">
                {detail.artifacts.map(a => (
                  <div key={a.id} className="text-[10px] rounded bg-secondary/30 px-2 py-1 text-muted-foreground">
                    [{a.kind}] {a.title || a.id}
                    {a.url && <a href={a.url} target="_blank" rel="noreferrer" className="ml-2 underline" style={{ color: ACCENT }}>打开</a>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    )
  }

  // List view
  return (
    <div className="flex flex-col h-full" style={{ fontFamily: MONO }}>
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border">
        <span className="text-[11px] font-medium text-foreground">Agent Tasks</span>
        <button onClick={fetchList} className="ml-auto text-muted-foreground hover:text-foreground">
          <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
        </button>
        <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="size-4" /></button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading && tasks === null && (
          <div className="flex justify-center py-10 text-muted-foreground"><Loader2 className="size-4 animate-spin" /></div>
        )}
        {error && (
          <p className="px-4 py-3 text-[11px] text-red-400">{error}</p>
        )}
        {tasks && tasks.length === 0 && (
          <p className="px-4 py-8 text-center text-[11px] text-muted-foreground">暂无 Agent 任务</p>
        )}
        {tasks?.map(t => (
          <button
            key={t.id}
            onClick={() => { setSelected(t.id); fetchDetail(t.id) }}
            className="w-full text-left px-4 py-2.5 border-b border-border/30 transition-colors hover:bg-secondary/40"
          >
            <div className="flex items-center gap-2">
              <span className={cn("shrink-0 text-[9px]", STATUS_COLOR[t.status])}>
                {STATUS_LABEL[t.status] ?? t.status}
              </span>
              {t.repo && <span className="text-[9px] text-muted-foreground/70">{t.repo}</span>}
              <span className="text-[9px] text-muted-foreground/50 ml-auto">
                {new Date(t.createdAt).toLocaleDateString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
              </span>
            </div>
            <p className="text-[11px] text-foreground/80 truncate mt-0.5">{t.goal}</p>
            {t.error && <p className="text-[10px] text-red-400/80 truncate mt-0.5">{t.error}</p>}
          </button>
        ))}
      </div>
    </div>
  )
}
