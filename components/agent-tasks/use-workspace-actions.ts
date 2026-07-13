"use client"

import { useCallback, useEffect, useState } from "react"
import type { WorkspaceStatus } from "@/lib/agent/types"
import type {
  DetectedCommands,
  GitStatusData,
  PendingConfirmation,
  PublishResult,
  RestoreResponse,
  SnapshotListResponse,
  VerifyData,
  WorkspaceDiff,
} from "./types"

export function useWorkspaceActions(taskId: string | null, workspaceStatus?: WorkspaceStatus) {
  const [wsDiff, setWsDiff] = useState<WorkspaceDiff | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const [showDiff, setShowDiff] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [restoreResult, setRestoreResult] = useState<RestoreResponse | null>(null)
  const [snapshotCount, setSnapshotCount] = useState(0)
  const [lastSnapshotId, setLastSnapshotId] = useState<string | null>(null)
  const [gitStatus, setGitStatus] = useState<GitStatusData | null>(null)
  const [publishing, setPublishing] = useState(false)
  const [publishResult, setPublishResult] = useState<PublishResult | null>(null)
  const [detectedCmds, setDetectedCmds] = useState<DetectedCommands | null>(null)
  const [verifyResult, setVerifyResult] = useState<VerifyData | null>(null)
  const [verifyLoading, setVerifyLoading] = useState(false)
  const [showVerify, setShowVerify] = useState(false)
  const [pendingConf, setPendingConf] = useState<PendingConfirmation | null>(null)
  const [confirming, setConfirming] = useState(false)

  const fetchDiff = useCallback(async (id: string) => {
    setDiffLoading(true)
    try {
      const [diffRes, snapRes, gitRes] = await Promise.all([
        fetch(`/api/agent/tasks/${id}/workspace/diff`),
        fetch(`/api/agent/tasks/${id}/workspace/snapshot`),
        fetch(`/api/agent/tasks/${id}/workspace/git`),
      ])
      if (diffRes.ok) setWsDiff(await diffRes.json())
      if (snapRes.ok) {
        const snapshotData: SnapshotListResponse = await snapRes.json()
        if (snapshotData.snapshots) {
          setSnapshotCount(snapshotData.snapshots.length)
          setLastSnapshotId(snapshotData.snapshots[0]?.snapshotId ?? null)
        }
      }
      if (gitRes.ok) setGitStatus(await gitRes.json())
    } catch {
      // Workspace telemetry is supplementary; the task detail remains usable.
    } finally {
      setDiffLoading(false)
    }
  }, [])

  const fetchConfirmation = useCallback(async (id: string) => {
    try {
      const response = await fetch(`/api/agent/tasks/${id}/confirm`)
      if (!response.ok) return
      const data = await response.json()
      setPendingConf(data?.status === "pending" ? data : null)
    } catch {
      setPendingConf(null)
    }
  }, [])

  useEffect(() => {
    if (taskId && (workspaceStatus === "ready" || workspaceStatus === "dirty")) {
      void fetchDiff(taskId)
      void fetchConfirmation(taskId)
    } else {
      setWsDiff(null)
      setShowDiff(false)
      setPendingConf(null)
    }
  }, [fetchConfirmation, fetchDiff, taskId, workspaceStatus])

  const fetchCommands = async () => {
    if (!taskId) return
    try {
      const response = await fetch(`/api/agent/tasks/${taskId}/workspace/commands`)
      if (response.ok) setDetectedCmds(await response.json())
    } catch {
      // Detection can be retried from the panel.
    }
  }

  const verify = async () => {
    if (!taskId) return
    setVerifyLoading(true)
    setVerifyResult(null)
    try {
      const response = await fetch(`/api/agent/tasks/${taskId}/workspace/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ install: false }),
      })
      setVerifyResult(await response.json())
    } catch {
      setVerifyResult({ ok: false, steps: [], failedStep: null, totalDurationMs: 0, summary: "请求失败" })
    } finally {
      setVerifyLoading(false)
    }
  }

  const decideConfirmation = async (action: "confirm" | "reject") => {
    if (!taskId || !pendingConf) return
    if (!pendingConf.confirmationToken) {
      if (pendingConf.operation === "publish") await publish(false)
      return
    }
    setConfirming(true)
    try {
      const response = await fetch(`/api/agent/tasks/${taskId}/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          operation: pendingConf.operation,
          confirmationId: pendingConf.id,
          confirmationToken: pendingConf.confirmationToken,
        }),
      })
      if (response.ok) {
        if (action === "confirm" && pendingConf.operation === "publish") {
          await publish(false, pendingConf)
        } else {
          setPendingConf(null)
          void fetchDiff(taskId)
        }
      }
    } catch {
      // Keep the card visible so the operation can be retried.
    } finally {
      setConfirming(false)
    }
  }

  const publish = async (askFirst = true, confirmation?: PendingConfirmation) => {
    if (!taskId) return
    if (!gitStatus?.hasChanges) {
      alert("没有可发布的改动")
      return
    }
    if (askFirst && !confirm("将 commit → push → 创建 Pull Request，确定发布？")) return
    setPublishing(true)
    setPublishResult(null)
    try {
      const response = await fetch(`/api/agent/tasks/${taskId}/workspace/git`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "publish",
          confirmationId: confirmation?.id,
          confirmationToken: confirmation?.confirmationToken,
        }),
      })
      const data = await response.json()
      setPublishResult(data)
      if (data.ok) {
        setPendingConf(null)
        void fetchDiff(taskId)
        setGitStatus(null)
      } else if (data.needsConfirmation && typeof data.confirmationId === "string") {
        setPendingConf({
          id: data.confirmationId,
          operation: typeof data.operation === "string" ? data.operation : "publish",
          riskLevel: data.risk?.level ?? "high",
          title: data.risk?.title ?? "高风险发布",
          reason: data.risk?.reason ?? data.error ?? "需要确认",
          files: Array.isArray(data.risk?.files) ? data.risk.files : [],
          status: "pending",
          confirmationToken: typeof data.confirmationToken === "string" ? data.confirmationToken : undefined,
          expiresAt: typeof data.expiresAt === "string" ? data.expiresAt : undefined,
        })
      }
    } catch {
      setPublishResult({ ok: false, error: "发布请求失败" })
    } finally {
      setPublishing(false)
    }
  }

  const restore = async () => {
    if (!taskId || !confirm("确定要恢复最近一次 snapshot？所有未保存的修改将丢失。")) return
    setRestoring(true)
    setRestoreResult(null)
    try {
      const response = await fetch(`/api/agent/tasks/${taskId}/workspace/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ useLast: true }),
      })
      const data: RestoreResponse = await response.json()
      setRestoreResult(data)
      if (response.ok) {
        setWsDiff(null)
        setShowDiff(false)
        void fetchDiff(taskId)
      } else {
        alert(data.error ?? "恢复失败")
      }
    } catch {
      alert("恢复失败")
    } finally {
      setRestoring(false)
    }
  }

  return {
    confirming,
    detectedCmds,
    diffLoading,
    fetchCommands,
    fetchDiff: () => taskId && fetchDiff(taskId),
    gitStatus,
    lastSnapshotId,
    pendingConf,
    publish: () => publish(),
    publishing,
    publishResult,
    restore,
    restoring,
    restoreResult,
    setShowDiff,
    setShowVerify,
    showDiff,
    showVerify,
    snapshotCount,
    verify,
    verifyLoading,
    verifyResult,
    wsDiff,
    confirm: () => decideConfirmation("confirm"),
    reject: () => decideConfirmation("reject"),
  }
}

export type WorkspaceActions = ReturnType<typeof useWorkspaceActions>
