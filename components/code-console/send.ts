import type { Dispatch, MutableRefObject, SetStateAction } from "react"

import { type Tier } from "@/lib/chat-data"
import { errorMessage, isRecord } from "@/lib/unknown-value"
import {
  createCodeSession,
  insertCodeMessage,
  touchCodeSession,
  toCodeModelMessages,
  type CodeMessage,
  type PlanAction,
} from "@/lib/code-data"
import { enqueueJob, streamJobEvents } from "@/components/literary-chat/job-stream-client"
import { initialCodeStreamState, type CodeStreamState } from "./stream"
import { applyCodeJobEnvelope } from './job-events'
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
}

function renderState(
  context: CodeSendContext,
  assistantId: string,
  previous: CodeStreamState,
  state: CodeStreamState,
) {
  if (state.taskId !== previous.taskId) context.setCurrentTaskId(state.taskId)
  context.setMessages(current => current.map(message => message.id === assistantId ? {
    ...message,
    content: state.fullText,
    steps: state.steps,
    plan: state.plan,
    taskId: state.taskId ?? undefined,
    isError: state.hadError || undefined,
  } : message))
  if (state.publishPending && !previous.publishPending) context.setPublishPending(true)
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
    if (!sessionId) throw new Error("无法创建代码会话")
    await insertCodeMessage(context.userId, sessionId, userMessage)
  } catch (error) {
    const message = errorMessage(error, "代码消息持久化失败")
    context.setMessages(current => current.map(item => item.id === assistantId ? {
      ...item, content: `请求失败：${message}`, isError: true,
    } : item))
    context.setStreaming(false)
    return
  }

  let taskId: string | null = options?.taskId ?? context.currentTaskId

  const history = toCodeModelMessages([...baseMessages, userMessage])
  let streamState = initialCodeStreamState(taskId)
  const controller = new AbortController()
  context.abortRef.current = controller

  try {
    const accepted = await enqueueJob("/api/code/chat", {
      repo: activeRepo,
      tier: context.tier,
      messages: history,
      taskId,
      responseId: assistantId,
      sessionId,
    }, controller.signal)
    for await (const envelope of streamJobEvents(accepted, controller.signal)) {
      const previous = streamState
      streamState = applyCodeJobEnvelope(streamState, envelope)
      taskId = streamState.taskId
      renderState(context, assistantId, previous, streamState)
    }
    if (!streamState.streamDone) {
      throw new Error("作业事件流在终态前结束")
    }
  } catch (error) {
    const name = isRecord(error) && typeof error.name === "string" ? error.name : ""
    const message = errorMessage(error, "未知错误")
    if (name === "AbortError") {
      if (!streamState.fullText) streamState = { ...streamState, fullText: "已停止。" }
    } else {
      streamState = {
        ...streamState,
        hadError: true,
        fullText: `${streamState.fullText ? `${streamState.fullText}\n\n` : ""}请求失败：${message}`,
      }
    }
    context.setMessages(current => current.map(message => message.id === assistantId ? {
      ...message,
      content: streamState.fullText,
      isError: streamState.hadError || undefined,
    } : message))
  } finally {
    context.setStreaming(false)
    context.abortRef.current = null
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
      void touchCodeSession(sessionId).catch(() => {})
    }
    if (streamState.plan.length && !streamState.hadError && !taskId) {
      if (context.auto) void context.applyPlan(streamState.plan, assistantId, completedMessages)
      else context.setPendingPlan(streamState.plan)
    }
    if (taskId && !streamState.hadError) {
      void context.syncWorkspaceState(taskId, completedMessages)
    }
  }
}
