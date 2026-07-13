import type { Dispatch, MutableRefObject, SetStateAction } from "react"

import { type Tier } from "@/lib/chat-data"
import {
  createCodeSession,
  insertCodeMessage,
  touchCodeSession,
  toCodeModelMessages,
  type CodeMessage,
  type PlanAction,
} from "@/lib/code-data"
import { initialCodeStreamState, parseCodeSseChunk, reduceCodeStreamEvent } from "./stream"
import type { RunCodeSendOptions } from "./use-task-recovery"

type CodeSendContext = {
  userId: string
  repo: string | null
  messages: CodeMessage[]
  streaming: boolean
  currentTaskId: string | null
  sessionId: string | null
  tier: Tier
  auto: boolean
  abortRef: MutableRefObject<AbortController | null>
  setMessages: Dispatch<SetStateAction<CodeMessage[]>>
  setStreaming: Dispatch<SetStateAction<boolean>>
  setApplyError: Dispatch<SetStateAction<string | null>>
  setWorkspaceDirty: Dispatch<SetStateAction<boolean>>
  setSessionId: Dispatch<SetStateAction<string | null>>
  setCurrentTaskId: Dispatch<SetStateAction<string | null>>
  setPublishPending: Dispatch<SetStateAction<boolean>>
  setPendingPlan: Dispatch<SetStateAction<PlanAction[]>>
  applyPlan: (plan: PlanAction[], assistantId: string, messages: CodeMessage[]) => Promise<void>
  syncWorkspaceState: (taskId: string, messages: CodeMessage[]) => Promise<void>
  scheduleTaskRecovery: (
    taskId: string,
    repo: string,
    messages: CodeMessage[],
    sessionId: string | null,
    resumeWaiting?: boolean,
    attempt?: number,
    responseId?: string,
  ) => void
}

export async function executeCodeSend(
  text: string,
  options: RunCodeSendOptions | undefined,
  context: CodeSendContext,
): Promise<void> {
  if (context.streaming && !options?.internal) return
  const activeRepo = options?.repo !== undefined ? options.repo : context.repo
  const baseMessages = options?.baseMessages ?? context.messages

  const userMessage: CodeMessage = { id: crypto.randomUUID(), role: "user", content: text }
  const assistantId = crypto.randomUUID()
  const assistantMessage: CodeMessage = { id: assistantId, role: "assistant", content: "", steps: [], plan: [] }
  context.setMessages(options?.internal
    ? [...baseMessages, assistantMessage]
    : [...baseMessages, userMessage, assistantMessage])
  context.setStreaming(true)
  context.setApplyError(null)
  if (!context.currentTaskId) context.setWorkspaceDirty(false)

  let sessionId = options?.sessionId !== undefined ? options.sessionId : context.sessionId
  try {
    if (!sessionId && activeRepo) {
      const firstUser = baseMessages.find(message => message.role === "user")?.content ?? text
      const createdSessionId = await createCodeSession(
        context.userId,
        activeRepo,
        firstUser.slice(0, 40) || "未命名",
      )
      if (createdSessionId) {
        sessionId = createdSessionId
        context.setSessionId(sessionId)
        for (const message of baseMessages) {
          await insertCodeMessage(context.userId, sessionId, message)
        }
      }
    }
    if (sessionId && !options?.internal) {
      void insertCodeMessage(context.userId, sessionId, userMessage)
    }
  } catch {
    // Persistence failure degrades history only; it must not swallow the message.
  }

  let taskId: string | null = options?.taskId ?? context.currentTaskId
  if (!taskId && activeRepo) {
    try {
      const goal = baseMessages.find(message => message.role === "user")?.content ?? text
      const response = await fetch("/api/agent/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ goal, mode: "auto", repo: activeRepo }),
      })
      if (response.ok) {
        const task = await response.json()
        if (task.id) {
          taskId = task.id
          context.setCurrentTaskId(taskId)
        }
      } else {
        console.error("[CodeConsole] POST /api/agent/tasks failed", response.status)
      }
    } catch (error) {
      console.error("[CodeConsole] POST /api/agent/tasks exception", error)
    }
  }

  const history = toCodeModelMessages([...baseMessages, userMessage])
  let streamState = initialCodeStreamState(taskId)
  let interrupted = false
  const controller = new AbortController()
  context.abortRef.current = controller

  try {
    const response = await fetch("/api/code/chat", {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repo: activeRepo,
        tier: context.tier,
        messages: history,
        taskId,
        responseId: assistantId,
        sessionId,
      }),
    })
    if (!response.ok) {
      const error = await response.json().catch(() => null)
      throw new Error(error?.error ?? `请求失败（${response.status}）`)
    }
    if (!response.body) throw new Error("无响应体")

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const parsed = parseCodeSseChunk(buffer, decoder.decode(value, { stream: true }))
      buffer = parsed.remainder
      for (const event of parsed.events) {
        const previous = streamState
        streamState = reduceCodeStreamEvent(streamState, event)
        if (streamState.taskId !== previous.taskId) {
          taskId = streamState.taskId
          context.setCurrentTaskId(taskId)
        } else if (streamState.steps !== previous.steps) {
          context.setMessages(current => current.map(message =>
            message.id === assistantId ? { ...message, steps: streamState.steps } : message))
        } else if (streamState.plan !== previous.plan) {
          context.setMessages(current => current.map(message =>
            message.id === assistantId ? { ...message, plan: streamState.plan } : message))
        } else if (streamState.fullText !== previous.fullText || streamState.hadError !== previous.hadError) {
          context.setMessages(current => current.map(message => message.id === assistantId ? {
            ...message,
            content: streamState.fullText,
            isError: streamState.hadError || undefined,
          } : message))
        }
        if (streamState.publishPending && !previous.publishPending) context.setPublishPending(true)
      }
    }
    if (!streamState.streamDone) throw new Error("后台连接意外中断")
  } catch (error: any) {
    if (error?.name === "AbortError") {
      if (!streamState.fullText) streamState = { ...streamState, fullText: "已停止。" }
    } else {
      interrupted = error?.name === "TypeError"
        || /连接|network|fetch|load failed|请求失败（5\d\d）/i.test(String(error?.message ?? error))
      if (interrupted && taskId && activeRepo) {
        streamState = {
          ...streamState,
          fullText: `${streamState.fullText ? `${streamState.fullText}\n\n` : ""}连接短暂中断，后台仍在继续执行，我正在自动接回结果……`,
        }
      } else {
        streamState = {
          ...streamState,
          hadError: true,
          fullText: `${streamState.fullText ? `${streamState.fullText}\n\n` : ""}请求失败：${error?.message ?? String(error)}`,
        }
      }
    }
    context.setMessages(current => current.map(message => message.id === assistantId ? {
      ...message,
      content: streamState.fullText,
      isError: streamState.hadError || undefined,
    } : message))
  } finally {
    if (!(taskId && activeRepo && interrupted)) context.setStreaming(false)
    const completedAssistant: CodeMessage = {
      id: assistantId,
      role: "assistant",
      content: streamState.fullText,
      steps: streamState.steps.length ? streamState.steps : undefined,
      plan: streamState.plan.length ? streamState.plan : undefined,
      taskId: taskId ?? undefined,
      isError: streamState.hadError || undefined,
    }
    const completedMessages = options?.internal
      ? [...baseMessages, completedAssistant]
      : [...baseMessages, userMessage, completedAssistant]

    if (sessionId) {
      void insertCodeMessage(context.userId, sessionId, completedAssistant).catch(() => {})
      void touchCodeSession(sessionId).catch(() => {})
    }
    if (streamState.plan.length && !streamState.hadError && !taskId) {
      if (context.auto) void context.applyPlan(streamState.plan, assistantId, completedMessages)
      else context.setPendingPlan(streamState.plan)
    }
    if (taskId && !streamState.hadError) {
      void context.syncWorkspaceState(taskId, completedMessages)
    }
    if (taskId && activeRepo && interrupted) {
      const interruptedAssistant: CodeMessage = {
        id: assistantId,
        role: "assistant",
        content: streamState.fullText,
        steps: streamState.steps.length ? streamState.steps : undefined,
        taskId,
        isError: true,
      }
      const recoveryMessages = options?.internal
        ? [...baseMessages, interruptedAssistant]
        : [...baseMessages, userMessage, interruptedAssistant]
      context.scheduleTaskRecovery(taskId, activeRepo, recoveryMessages, sessionId, false, 0, assistantId)
    }
  }
}
