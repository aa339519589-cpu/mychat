"use client"

import { useEffect, useRef, type Dispatch, type SetStateAction } from "react"

import { isFalseCodePause, isStaleRunningCodeTask, shouldShowWorkspacePublish } from "@/lib/code-agent-ui"
import { fetchCodeMessages, type CodeMessage } from "@/lib/code-data"

export type RunCodeSendOptions = {
  internal?: boolean
  baseMessages?: CodeMessage[]
  repo?: string | null
  taskId?: string
  sessionId?: string | null
}

export type RunCodeSend = (text: string, options?: RunCodeSendOptions) => Promise<void>

export function useTaskRecovery(options: {
  messages: CodeMessage[]
  runSend: RunCodeSend
  setMessages: Dispatch<SetStateAction<CodeMessage[]>>
  setStreaming: Dispatch<SetStateAction<boolean>>
  setCurrentTaskId: Dispatch<SetStateAction<string | null>>
  setWorkspaceDirty: Dispatch<SetStateAction<boolean>>
  setPublishPending: Dispatch<SetStateAction<boolean>>
}) {
  const recoveryTimersRef = useRef(new Map<string, number>())

  useEffect(() => () => {
    for (const timer of recoveryTimersRef.current.values()) window.clearTimeout(timer)
    recoveryTimersRef.current.clear()
  }, [])

  async function syncWorkspaceState(taskId: string, knownMessages = options.messages) {
    try {
      const [gitResponse, detailResponse] = await Promise.all([
        fetch(`/api/agent/tasks/${taskId}/workspace/git`),
        fetch(`/api/agent/tasks/${taskId}`),
      ])
      const hasChanges = gitResponse.ok ? !!(await gitResponse.json()).hasChanges : false
      options.setWorkspaceDirty(hasChanges)

      const task = detailResponse.ok ? await detailResponse.json() as {
        status?: string | null
        pullRequestUrl?: string | null
        steps?: { kind?: string | null; label?: string | null }[]
      } : null
      options.setPublishPending(shouldShowWorkspacePublish(task, knownMessages, hasChanges))
    } catch (error) {
      console.warn("[CodeConsole] workspace state sync failed (non-blocking)", error)
    }
  }

  function scheduleTaskRecovery(
    taskId: string,
    activeRepo: string,
    baseMessages: CodeMessage[],
    sessionId: string | null,
    resumeWaiting = false,
    attempt = 0,
    responseId?: string,
  ) {
    if (recoveryTimersRef.current.has(taskId)) return
    options.setStreaming(true)
    const delay = Math.min(1_500 * 2 ** attempt, 30_000)
    const timer = window.setTimeout(async () => {
      recoveryTimersRef.current.delete(taskId)
      try {
        const response = await fetch(`/api/agent/tasks/${taskId}`)
        if (!response.ok) throw new Error("task unavailable")
        const task = await response.json() as { status?: string; updatedAt?: string }
        if (resumeWaiting && task.status === "waiting_for_user") {
          await fetch(`/api/agent/tasks/${taskId}/resume`, { method: "POST" })
          void options.runSend("刚才错误地暂停了。继续完成原始任务；安装、构建、验证、修复和重试全部自主执行，除确认发布外不要再等待用户。", {
            internal: true,
            baseMessages,
            repo: activeRepo,
            taskId,
            sessionId,
          })
          return
        }
        if (task.status !== "running") {
          if (sessionId) {
            const refreshed = await fetchCodeMessages(sessionId)
            if (refreshed.length) options.setMessages(refreshed)
          }
          options.setStreaming(false)
          await syncWorkspaceState(taskId, baseMessages)
          return
        }
        if (!isStaleRunningCodeTask(task.status, task.updatedAt)) {
          scheduleTaskRecovery(taskId, activeRepo, baseMessages, sessionId, false, attempt + 1, responseId)
          return
        }
        void options.runSend("后台执行连接刚才中断了。根据已有工具结果和原始目标从断点继续，先检查 workspace 当前状态，不要从头重做，直到 publish 或 complete。", {
          internal: true,
          baseMessages,
          repo: activeRepo,
          taskId,
          sessionId,
        })
      } catch {
        scheduleTaskRecovery(taskId, activeRepo, baseMessages, sessionId, resumeWaiting, attempt + 1, responseId)
      }
    }, delay)
    recoveryTimersRef.current.set(taskId, timer)
  }

  async function restoreTask(repo: string, messages: CodeMessage[], sessionId: string | null) {
    const savedTaskId = [...messages].reverse().find(message => message.taskId)?.taskId
    try {
      const response = await fetch(`/api/agent/tasks?repo=${encodeURIComponent(repo)}`)
      if (!response.ok) return
      const tasks = await response.json() as { id: string; status: string; updatedAt?: string }[]
      const active = new Set(["queued", "planning", "editing", "running", "waiting_for_user", "creating_pr"])
      const task = tasks.find(item => item.id === savedTaskId && active.has(item.status))
        ?? tasks.find(item => active.has(item.status))
      if (!task) return

      options.setCurrentTaskId(task.id)
      await syncWorkspaceState(task.id, messages)
      const falsePause = isFalseCodePause(task.status, messages)
      if (task.status === "running" || falsePause) {
        const responseId = [...messages].reverse()
          .find(message => message.taskId === task.id && message.role === "assistant")?.id
        scheduleTaskRecovery(task.id, repo, messages, sessionId, falsePause, 0, responseId)
      }
    } catch {
      // Task recovery is best-effort and must never block entering a repo.
    }
  }

  return { restoreTask, scheduleTaskRecovery, syncWorkspaceState }
}

