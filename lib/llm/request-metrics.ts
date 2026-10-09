import { isRecord } from '@/lib/unknown-value'

function bytes(value: unknown): number {
  return value === undefined ? 0 : Buffer.byteLength(JSON.stringify(value), 'utf8')
}

/** Sizes only: never log prompt bodies, URLs, credentials, attachments or hashes. */
export function modelRequestMetrics(body: Record<string, unknown>) {
  const tools = Array.isArray(body.tools) ? body.tools : []
  const messages = Array.isArray(body.messages) ? body.messages : []
  const system = body.system ?? messages.filter(message => isRecord(message) && message.role === 'system')
  const conversation = body.system === undefined
    ? messages.filter(message => !isRecord(message) || message.role !== 'system') : messages
  const systemBlocks = Array.isArray(system) ? system : []
  return {
    requestBytes: bytes(body),
    systemBytes: bytes(system),
    toolSchemaBytes: bytes(tools),
    conversationBytes: bytes(conversation),
    messageCount: conversation.length,
    toolCount: tools.length,
    explicitCacheBoundaries: [...tools, ...systemBlocks]
      .filter(block => isRecord(block) && isRecord(block.cache_control)).length,
  }
}
