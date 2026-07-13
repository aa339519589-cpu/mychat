import type { Dispatch, SetStateAction } from "react"

import {
  insertCodeMessage,
  type ApplyResult,
  type CodeMessage,
  type PlanAction,
} from "@/lib/code-data"
import type { RunCodeSend } from "./use-task-recovery"

type CodeApplyContext = {
  userId: string
  repo: string | null
  sessionId: string | null
  messages: CodeMessage[]
  currentTaskId: string | null
  runSend: RunCodeSend
  setRepo: Dispatch<SetStateAction<string | null>>
  invalidateRepos: () => void
  setMessages: Dispatch<SetStateAction<CodeMessage[]>>
  setPendingPlan: Dispatch<SetStateAction<PlanAction[]>>
  setApplying: Dispatch<SetStateAction<boolean>>
  setApplyError: Dispatch<SetStateAction<string | null>>
  setWorkspaceDirty: Dispatch<SetStateAction<boolean>>
  setPublishPending: Dispatch<SetStateAction<boolean>>
}

function commitSummary(messages: CodeMessage[], assistantId: string): string {
  const lines = (messages.find(message => message.id === assistantId)?.content ?? "")
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean)
  const conversationalPrefix = /^(好的|我来|让我|先|这个|那个|嗯|哦|好|可以|收到|明白|懂了|行|OK|ok|OK\.|Yes|yes|Sure|sure|Let|let|I'll|I will)/
  const substantive = lines.find(line => !conversationalPrefix.test(line)) ?? lines[0] ?? ""
  return substantive.slice(0, 80) || "Code Agent 代码改动"
}

export function createCodeApplyActions(context: CodeApplyContext) {
  async function appendReceipt(
    result: ApplyResult,
    taskId: string | null,
    baseMessages = context.messages,
  ): Promise<CodeMessage[]> {
    const receipt: CodeMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      content: "",
      result,
      taskId: taskId ?? undefined,
    }
    const nextMessages = [...baseMessages, receipt]
    context.setMessages(nextMessages)
    if (context.sessionId) {
      await insertCodeMessage(context.userId, context.sessionId, receipt).catch(() => {})
    }
    return nextMessages
  }

  async function publishWorkspacePR(): Promise<void> {
    if (!context.currentTaskId || !context.repo) return
    context.setApplying(true)
    context.setApplyError(null)
    try {
      const response = await fetch("/api/code/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repo: context.repo,
          taskId: context.currentTaskId,
          actions: [],
          mode: "workspace_pr",
        }),
      })
      const data = await response.json()
      if (!response.ok) {
        context.setApplyError(data.error ?? "PR 创建失败")
        return
      }

      const nextMessages = await appendReceipt(data as ApplyResult, context.currentTaskId)
      context.setWorkspaceDirty(false)
      context.setPublishPending(false)
      context.setApplying(false)
      void context.runSend(
        "平台已经完成本次确认操作。根据执行回执继续完成原始任务，主动检查发布和网页状态；只有整个目标真正完成并验证后才能结束。",
        { internal: true, baseMessages: nextMessages, repo: context.repo },
      )
    } catch {
      context.setApplyError("网络错误")
    } finally {
      context.setApplying(false)
    }
  }

  async function applyPlan(
    plan: PlanAction[],
    assistantId: string,
    baseMessages = context.messages,
  ): Promise<void> {
    if (!plan.length) return
    context.setApplying(true)
    context.setApplyError(null)
    try {
      const response = await fetch("/api/code/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repo: context.repo,
          actions: plan,
          message: commitSummary(baseMessages, assistantId),
        }),
      })
      const data = await response.json()
      if (!response.ok) {
        context.setApplyError(data.error ?? "执行失败")
        return
      }

      const result = data as ApplyResult
      if (result.created && result.repo) {
        context.setRepo(result.repo)
        context.invalidateRepos()
      }
      const nextMessages = await appendReceipt(result, null, baseMessages)
      context.setPendingPlan([])
      context.setWorkspaceDirty(false)
      if (result.created && result.repo) {
        context.setApplying(false)
        void context.runSend(
          "平台已执行确认操作。根据执行回执继续完成原始任务，检查真实仓库和部署状态；只有全部完成并验证后才结束。",
          { internal: true, baseMessages: nextMessages, repo: result.repo },
        )
      }
    } catch {
      context.setApplyError("网络错误")
    } finally {
      context.setApplying(false)
    }
  }

  return { applyPlan, publishWorkspacePR }
}
