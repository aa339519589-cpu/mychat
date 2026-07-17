import type { Dispatch, MutableRefObject, SetStateAction } from "react"

import {
  enqueueJob,
  streamJobEvents,
  type AcceptedJob,
  type JobStreamEnvelope,
} from "@/components/literary-chat/job-stream-client"
import { type Tier } from "@/lib/chat-data"
import {
  createCodeSession,
  insertCodeMessage,
  touchCodeSession,
  toCodeModelMessages,
  type CodeMessage,
  type PlanAction,
} from "@/lib/code-data"
import { provisionalRepositoryForSession } from "@/lib/code-agent/provisional-repository"
import { errorMessage, isRecord } from "@/lib/unknown-value"
import { applyCodeJobEnvelope } from "./job-events"
import { initialCodeStreamState, type CodeStreamState } from "./stream"
import type { RunCodeSendOptions } from "./use-task-recovery"

export type CodeSendContext = {
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

export type CodeSendDependencies = {
  createSession: typeof createCodeSession
  insertMessage: typeof insertCodeMessage
  touchSession: typeof touchCodeSession
  enqueue: typeof enqueueJob
  stream: (
    accepted: AcceptedJob,
    signal: AbortSignal,
  ) => AsyncIterable<JobStreamEnvelope>
  randomId: () => string
}

type CodeSendRequest = {
  activeRepo: string | null
  baseMessages: CodeMessage[]
  userMessage: CodeMessage
  assistantId: string
  assistantMessage: CodeMessage
  internal: boolean
  initialSessionId: string | null
  initialTaskId: string | null
}

type SessionResult =
  | { ok: true; sessionId: string }
  | { ok: false; error: string }

type StreamAccumulator = { state: CodeStreamState }

const DEFAULT_DEPENDENCIES: CodeSendDependencies = {
  createSession: createCodeSession,
  insertMessage: insertCodeMessage,
  touchSession: touchCodeSession,
  enqueue: enqueueJob,
  stream: streamJobEvents,
  randomId: () => crypto.randomUUID(),
}

function createRequest(
  text: string,
  options: RunCodeSendOptions | undefined,
  context: CodeSendContext,
  randomId: () => string,
): CodeSendRequest {
  const assistantId = randomId()
  return {
    activeRepo: options?.repo !== undefined ? options.repo : context.repo,
    baseMessages: options?.baseMessages ?? context.messages,
    userMessage: { id: randomId(), role: "user", content: text },
    assistantId,
    assistantMessage: { id: assistantId, role: "assistant", content: "", steps: [], plan: [] },
    internal: options?.internal === true,
    initialSessionId: options?.sessionId !== undefined ? options.sessionId : context.sessionId,
    initialTaskId: options?.taskId ?? context.currentTaskId,
  }
}

function beginSend(request: CodeSendRequest, context: CodeSendContext): void {
  context.setMessages(request.internal
    ? [...request.baseMessages, request.assistantMessage]
    : [...request.baseMessages, request.userMessage, request.assistantMessage])
  context.setStreaming(true)
  context.setApplyError(null)
  if (!context.currentTaskId) context.setWorkspaceDirty(false)
}

async function createSessionWithHistory(
  request: CodeSendRequest,
  context: CodeSendContext,
  dependencies: CodeSendDependencies,
): Promise<string> {
  const firstUser = request.baseMessages.find(message => message.role === "user")?.content
    ?? request.userMessage.content
  const sessionId = await dependencies.createSession(
    context.userId,
    request.activeRepo,
    firstUser.slice(0, 40) || "未命名",
  )
  if (!sessionId) throw new Error("无法创建代码会话")
  context.setSessionId(sessionId)
  for (const message of request.baseMessages) {
    await dependencies.insertMessage(context.userId, sessionId, message)
  }
  return sessionId
}

async function persistSendStart(
  request: CodeSendRequest,
  context: CodeSendContext,
  dependencies: CodeSendDependencies,
): Promise<SessionResult> {
  try {
  const sessionId = request.initialSessionId
      ?? await createSessionWithHistory(request, context, dependencies)
    if (!request.internal) {
      await dependencies.insertMessage(context.userId, sessionId, request.userMessage)
    }
    return { ok: true, sessionId }
  } catch (error) {
    return { ok: false, error: errorMessage(error, "代码消息持久化失败") }
  }
}

function showStartFailure(context: CodeSendContext, assistantId: string, message: string): void {
  context.setMessages(current => current.map(item => item.id === assistantId ? {
    ...item,
    content: `请求失败：${message}`,
    isError: true,
  } : item))
  context.setStreaming(false)
}

function renderState(
  context: CodeSendContext,
  assistantId: string,
  previous: CodeStreamState,
  state: CodeStreamState,
): void {
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

async function consumeStream(
  request: CodeSendRequest,
  context: CodeSendContext,
  dependencies: CodeSendDependencies,
  controller: AbortController,
  sessionId: string,
  accumulator: StreamAccumulator,
): Promise<void> {
  const accepted = await dependencies.enqueue("/api/code/chat", {
    repo: request.activeRepo ?? provisionalRepositoryForSession(sessionId),
    tier: context.tier,
    messages: toCodeModelMessages([...request.baseMessages, request.userMessage]),
    taskId: request.initialTaskId,
    responseId: request.assistantId,
    sessionId,
  }, controller.signal)
  for await (const envelope of dependencies.stream(accepted, controller.signal)) {
    const previous = accumulator.state
    accumulator.state = applyCodeJobEnvelope(accumulator.state, envelope)
    renderState(context, request.assistantId, previous, accumulator.state)
  }
  if (!accumulator.state.streamDone) throw new Error("作业事件流在终态前结束")
}

function failedStreamState(state: CodeStreamState, error: unknown): CodeStreamState {
  const name = isRecord(error) && typeof error.name === "string" ? error.name : ""
  if (name === "AbortError") {
    return state.fullText ? state : { ...state, fullText: "已停止。" }
  }
  const message = errorMessage(error, "未知错误")
  return {
    ...state,
    hadError: true,
    fullText: `${state.fullText ? `${state.fullText}\n\n` : ""}请求失败：${message}`,
  }
}

function completedMessage(assistantId: string, taskId: string | null, state: CodeStreamState): CodeMessage {
  return {
    id: assistantId,
    role: "assistant",
    content: state.fullText,
    steps: state.steps.length ? state.steps : undefined,
    plan: state.plan.length ? state.plan : undefined,
    taskId: taskId ?? undefined,
    isError: state.hadError || undefined,
  }
}

async function persistCompletion(
  context: CodeSendContext,
  dependencies: CodeSendDependencies,
  sessionId: string,
  message: CodeMessage,
): Promise<void> {
  try {
    await dependencies.insertMessage(context.userId, sessionId, message)
  } catch {
    context.setApplyError("回复已生成，但未能保存到会话历史。")
  }
  void dependencies.touchSession(sessionId).catch(() => {})
}

async function finalizeSend(
  request: CodeSendRequest,
  context: CodeSendContext,
  dependencies: CodeSendDependencies,
  sessionId: string,
  state: CodeStreamState,
): Promise<void> {
  const taskId = state.taskId
  const planning = request.activeRepo === null
  const assistant = completedMessage(request.assistantId, taskId, state)
  const completedMessages = request.internal
    ? [...request.baseMessages, assistant]
    : [...request.baseMessages, request.userMessage, assistant]
  await persistCompletion(context, dependencies, sessionId, assistant)
  if (state.plan.length && !state.hadError && planning) {
    context.setCurrentTaskId(null)
    if (context.auto) void context.applyPlan(state.plan, request.assistantId, completedMessages)
    else context.setPendingPlan(state.plan)
  }
  if (taskId && !state.hadError && !planning) {
    void context.syncWorkspaceState(taskId, completedMessages)
  }
}

function releaseController(context: CodeSendContext, controller: AbortController): void {
  if (context.abortRef.current !== controller) return
  context.abortRef.current = null
  context.setStreaming(false)
}

export async function executeCodeSend(
  text: string,
  options: RunCodeSendOptions | undefined,
  context: CodeSendContext,
  overrides: Partial<CodeSendDependencies> = {},
): Promise<void> {
  if (context.streaming && !options?.internal) return
  const dependencies: CodeSendDependencies = { ...DEFAULT_DEPENDENCIES, ...overrides }
  const request = createRequest(text, options, context, dependencies.randomId)
  beginSend(request, context)

  const persisted = await persistSendStart(request, context, dependencies)
  if (!persisted.ok) {
    showStartFailure(context, request.assistantId, persisted.error)
    return
  }

  const controller = new AbortController()
  context.abortRef.current = controller
  const stream = { state: initialCodeStreamState(request.initialTaskId) }
  try {
    await consumeStream(request, context, dependencies, controller, persisted.sessionId, stream)
  } catch (error) {
    const previous = stream.state
    stream.state = failedStreamState(stream.state, error)
    renderState(context, request.assistantId, previous, stream.state)
  } finally {
    releaseController(context, controller)
    await finalizeSend(request, context, dependencies, persisted.sessionId, stream.state)
  }
}
