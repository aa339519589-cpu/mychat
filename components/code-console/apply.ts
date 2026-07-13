import type { Dispatch, SetStateAction } from "react"
import {
  streamJobEvents,
  type AcceptedJob,
} from "@/components/literary-chat/job-stream-client"
import { isRecord } from "@/lib/unknown-value"

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
  setCurrentTaskId: Dispatch<SetStateAction<string | null>>
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
  async function executeConfirmedOperation(
    requestBody: Record<string, unknown>,
    taskId: string,
  ): Promise<ApplyResult> {
    const controller = new AbortController()
    const post = () => fetch("/api/code/apply", {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    })
    let response = await post()
    let data: unknown = await response.json().catch(() => null)
    if (response.status === 409 && isRecord(data) && data.needsConfirmation === true
        && typeof data.confirmationId === "string"
        && typeof data.confirmationToken === "string"
        && data.operation === "publish") {
      const risk = isRecord(data.risk) ? data.risk : null
      const accepted = confirm(`${risk?.title ?? "高风险发布"}\n\n${risk?.reason ?? data.error ?? "请确认是否继续"}`)
      const decision = await fetch(`/api/agent/tasks/${taskId}/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: accepted ? "confirm" : "reject",
          operation: "publish",
          confirmationId: data.confirmationId,
          confirmationToken: data.confirmationToken,
          reason: accepted ? undefined : "用户取消发布",
        }),
      })
      if (!accepted) throw new Error(decision.ok ? "已取消高风险发布" : "拒绝确认失败")
      if (!decision.ok) {
        const failure: unknown = await decision.json().catch(() => null)
        throw new Error(isRecord(failure) && typeof failure.error === "string" ? failure.error : "确认失败")
      }
      requestBody.confirmationId = data.confirmationId
      requestBody.confirmationToken = data.confirmationToken
      response = await post()
      data = await response.json().catch(() => null)
    }
    if (!response.ok) {
      throw new Error(isRecord(data) && typeof data.error === "string" ? data.error : "发布作业入队失败")
    }
    if (!isRecord(data) || typeof data.jobId !== "string"
        || typeof data.streamUrl !== "string" || typeof data.status !== "string") {
      throw new Error("发布作业入队响应无效")
    }
    const accepted: AcceptedJob = { jobId: data.jobId, streamUrl: data.streamUrl, status: data.status }
    for await (const event of streamJobEvents(accepted, controller.signal, 50 * 60_000)) {
      if (event.kind !== "job.terminal") continue
      if (event.payload.status !== "completed" || !isRecord(event.payload.result)) {
        const code = typeof event.payload.errorCode === "string" ? `：${event.payload.errorCode}` : ""
        throw new Error(`发布作业失败${code}`)
      }
      return event.payload.result as ApplyResult
    }
    throw new Error("发布作业在终态前结束")
  }

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
      const requestBody: Record<string, unknown> = {
        repo: context.repo,
        taskId: context.currentTaskId,
        actions: [],
        mode: "workspace_pr",
      }
      const result = await executeConfirmedOperation(requestBody, context.currentTaskId)
      const nextMessages = await appendReceipt(result, context.currentTaskId)
      context.setWorkspaceDirty(false)
      context.setPublishPending(false)
      context.setApplying(false)
      void context.runSend(
        "平台已经完成本次确认操作。根据执行回执继续完成原始任务，主动检查发布和网页状态；只有整个目标真正完成并验证后才能结束。",
        { internal: true, baseMessages: nextMessages, repo: context.repo },
      )
    } catch (error) {
      context.setApplyError(error instanceof Error ? error.message : "网络错误")
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
      const taskId = crypto.randomUUID()
      const result = await executeConfirmedOperation({
        repo: context.repo,
        taskId,
        actions: plan,
        message: commitSummary(baseMessages, assistantId),
      }, taskId)
      context.setCurrentTaskId(taskId)
      if (result.created && result.repo) {
        context.setRepo(result.repo)
        context.invalidateRepos()
      }
      const nextMessages = await appendReceipt(result, taskId, baseMessages)
      context.setPendingPlan([])
      context.setWorkspaceDirty(false)
      if (result.created && result.repo) {
        context.setApplying(false)
        void context.runSend(
          "平台已执行确认操作。根据执行回执继续完成原始任务，检查真实仓库和部署状态；只有全部完成并验证后才结束。",
          { internal: true, baseMessages: nextMessages, repo: result.repo },
        )
      }
    } catch (error) {
      context.setApplyError(error instanceof Error ? error.message : "网络错误")
    } finally {
      context.setApplying(false)
    }
  }

  return { applyPlan, publishWorkspacePR }
}
