import { validate } from '@/lib/validation'
import { isValidGitHubRepository } from '@/lib/agent/git-publish/shared'
import {
  MAX_CODE_CONTEXT_BYTES,
  MAX_CODE_CONTEXT_MESSAGES,
} from './context'
import { isProvisionalRepositoryForSession } from './provisional-repository'

export type CodeChatMessage = {
  role: 'user' | 'assistant'
  content: string
}

export type CodeChatRequest = {
  repo: string | null
  modelId: string
  reasoningEffort?: string
  messages: CodeChatMessage[]
  taskId: string | null
  responseId: string | null
  sessionId: string | null
}

function optionalUuid(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null
  validate.uuid(value, field)
  return value as string
}

function requiredModelId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200
    || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('模型标识无效')
  }
  return value.trim()
}

function optionalReasoningEffort(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || !value.trim() || value.length > 32
    || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('思考深度无效')
  }
  return value.trim().toLowerCase()
}

function repositoryOf(value: unknown, sessionId: string | null): string | null {
  const repo = value ?? null
  if (repo === null) return null
  if (typeof repo !== 'string') throw new Error('仓库参数无效')
  const provisional = sessionId !== null && isProvisionalRepositoryForSession(repo, sessionId)
  const reserved = repo.startsWith('__mychat_new__/')
  if (reserved ? !provisional : !isValidGitHubRepository(repo)) throw new Error('仓库参数无效')
  return repo
}

function messagesOf(value: unknown): CodeChatMessage[] {
  validate.array(value, 'messages', { minLength: 1, maxLength: MAX_CODE_CONTEXT_MESSAGES })
  let totalBytes = 0
  const encoder = new TextEncoder()
  for (const message of value as unknown[]) {
    if (!message || typeof message !== 'object'
      || !('role' in message) || (message.role !== 'user' && message.role !== 'assistant')
      || !('content' in message) || typeof message.content !== 'string') {
      throw new Error('消息格式或角色无效')
    }
    if (message.content.length > 100_000) throw new Error('单条消息过长')
    totalBytes += encoder.encode(message.content).byteLength
  }
  if (totalBytes > MAX_CODE_CONTEXT_BYTES) throw new Error('消息上下文过大')
  return value as CodeChatMessage[]
}

/** Validate and normalize the untrusted JSON body before any external work starts. */
export function parseCodeChatRequest(input: unknown): CodeChatRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('请求体格式无效')
  }

  const body = input as Record<string, unknown>
  const taskId = optionalUuid(body.taskId, 'taskId')
  const responseId = optionalUuid(body.responseId, 'responseId')
  const sessionId = optionalUuid(body.sessionId, 'sessionId')
  const reasoningEffort = optionalReasoningEffort(body.reasoningEffort)

  return {
    repo: repositoryOf(body.repo, sessionId),
    modelId: requiredModelId(body.modelId),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    messages: messagesOf(body.messages),
    taskId,
    responseId,
    sessionId,
  }
}
