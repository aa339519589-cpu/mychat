import type { CodeChatMessage } from './request'

export type CodeAgentMode = 'plan' | 'workspace'

export const CODE_CONTEXT_POLICIES = {
  plan: { messages: 16, maxBytes: 64 * 1024 },
  workspace: { messages: 32, maxBytes: 128 * 1024 },
} as const

export const MAX_CODE_CONTEXT_MESSAGES = CODE_CONTEXT_POLICIES.workspace.messages
export const MAX_CODE_CONTEXT_BYTES = CODE_CONTEXT_POLICIES.workspace.maxBytes

export function codeAgentMode(hasRepository: boolean): CodeAgentMode {
  return hasRepository ? 'workspace' : 'plan'
}

export function codeContextPolicy(mode: CodeAgentMode) {
  return CODE_CONTEXT_POLICIES[mode]
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

export function trimCodeContextMessages<T extends CodeChatMessage>(
  messages: T[],
  mode: CodeAgentMode,
): T[] {
  const policy = codeContextPolicy(mode)
  const recent = messages.slice(-policy.messages)
  const kept: T[] = []
  let totalBytes = 0

  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const message = recent[index]
    const messageBytes = utf8Bytes(message.content)
    if (kept.length > 0 && totalBytes + messageBytes > policy.maxBytes) break
    kept.push(message)
    totalBytes += messageBytes
  }

  return kept.reverse()
}
