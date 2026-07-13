import { validate } from '@/lib/validation'
import type { ModelMessage } from '@/lib/llm/types'

export type CodeChatMessage = {
  role: 'user' | 'assistant'
  content: string
}

export type CodeChatRequest = {
  repo: string | null
  tier: string
  messages: CodeChatMessage[]
  taskId: string | null
  responseId: string | null
  sessionId: string | null
  resumeMessages?: ModelMessage[]
}

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

/** Validate and normalize the untrusted JSON body before any external work starts. */
export function parseCodeChatRequest(input: unknown): CodeChatRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('请求体格式无效')
  }

  const body = input as Record<string, unknown>
  const repo = body.repo ?? null
  const tier = body.tier ?? '正构'
  const messages = body.messages
  const taskId = body.taskId ?? null
  const responseId = body.responseId ?? null
  const sessionId = body.sessionId ?? null

  validate.array(messages, 'messages', { minLength: 1, maxLength: 200 })
  if (repo !== null && (typeof repo !== 'string' || !REPO_PATTERN.test(repo))) {
    throw new Error('仓库参数无效')
  }
  if (taskId !== null) validate.uuid(taskId, 'taskId')
  if (responseId !== null) validate.uuid(responseId, 'responseId')
  if (sessionId !== null) validate.uuid(sessionId, 'sessionId')

  let totalChars = 0
  for (const message of messages as unknown[]) {
    if (
      !message
      || typeof message !== 'object'
      || !('role' in message)
      || (message.role !== 'user' && message.role !== 'assistant')
      || !('content' in message)
      || typeof message.content !== 'string'
    ) {
      throw new Error('消息格式或角色无效')
    }
    if (message.content.length > 100_000) throw new Error('单条消息过长')
    totalChars += message.content.length
  }
  if (totalChars > 2_000_000) throw new Error('消息上下文过大')

  return {
    repo: repo as string | null,
    tier: typeof tier === 'string' ? tier : '正构',
    messages: messages as CodeChatMessage[],
    taskId: taskId as string | null,
    responseId: responseId as string | null,
    sessionId: sessionId as string | null,
    resumeMessages: Array.isArray(body.resumeMessages) ? body.resumeMessages as ModelMessage[] : undefined,
  }
}
