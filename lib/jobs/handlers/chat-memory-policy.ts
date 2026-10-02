export type ChatMemoryPolicyInput<Memory> = {
  customEndpoint: boolean
  memoryEnabled: boolean
  inProject: boolean
  memories: Memory[]
}

export type ChatMemoryPolicy<Memory> = {
  enabled: boolean
  globalMemories: Memory[] | undefined
}

/**
 * Apply the account Memory switch consistently across built-in and custom
 * models. Global memories are available only in main chats; project memory
 * tools remain on the platform path, where project context is supported.
 */
export function resolveChatMemoryPolicy<Memory>(
  input: ChatMemoryPolicyInput<Memory>,
): ChatMemoryPolicy<Memory> {
  const enabled = input.memoryEnabled && (!input.customEndpoint || !input.inProject)
  return {
    enabled,
    globalMemories: enabled && !input.inProject ? input.memories : undefined,
  }
}
