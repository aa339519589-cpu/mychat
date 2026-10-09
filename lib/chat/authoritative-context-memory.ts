import type { SupabaseClient } from '@/lib/supabase/types'
import type { Memory } from '@/lib/memory-data'
import { isRecord } from '@/lib/unknown-value'

export const MAX_MEMORIES = 200
export const MAX_AUTHORITATIVE_CONTEXT_BYTES = 256 * 1024
// The callers already cap history at 48 and memories at 200 rows. Read that
// bounded set in one round trip without changing any context or byte limits.
export const CONTEXT_PAGE_SIZE = 200
const encoder = new TextEncoder()

export type MemoryPreferences = { enabled: boolean; sensitiveEnabled: boolean }

export class AuthoritativeContextError extends Error {
  constructor(
    public readonly code:
      | 'CONVERSATION_NOT_FOUND'
      | 'USER_MESSAGE_NOT_FOUND'
      | 'CONTEXT_TOO_LARGE'
      | 'CONTEXT_UNAVAILABLE',
    message: string,
  ) {
    super(message)
    this.name = 'AuthoritativeContextError'
  }
}

export function jsonBytes(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).byteLength
}

type PageResult = { data: unknown; error: unknown }

export async function loadBoundedCollection<T>(input: {
  maxRows: number
  fetchPage: (from: number, to: number) => PromiseLike<PageResult>
  map: (value: unknown) => T
  unavailableMessage: string
}): Promise<T[]> {
  const values: T[] = []
  let bytes = 2
  for (let offset = 0; offset < input.maxRows; offset += CONTEXT_PAGE_SIZE) {
    const pageSize = Math.min(CONTEXT_PAGE_SIZE, input.maxRows - offset)
    const result = await input.fetchPage(offset, offset + pageSize - 1)
    if (result.error || !Array.isArray(result.data)) {
      throw new AuthoritativeContextError('CONTEXT_UNAVAILABLE', input.unavailableMessage)
    }
    for (const row of result.data) {
      const mapped = input.map(row)
      bytes += jsonBytes(mapped) + 1
      if (bytes > MAX_AUTHORITATIVE_CONTEXT_BYTES) {
        throw new AuthoritativeContextError(
          'CONTEXT_TOO_LARGE',
          '权威对话、项目或记忆上下文超过处理上限',
        )
      }
      values.push(mapped)
    }
    if (result.data.length < pageSize) break
  }
  return values
}

export async function loadGlobalMemories(
  client: SupabaseClient,
  userId: string,
  conversationMemoryEnabled: boolean,
  prefetchedPreferences?: Promise<MemoryPreferences>,
): Promise<{ enabled: boolean; sensitiveEnabled: boolean; memories: Memory[] }> {
  const preferences = await (prefetchedPreferences ?? loadMemoryPreferences(client, userId))
  if (!preferences.enabled || !conversationMemoryEnabled) {
    return { ...preferences, enabled: false, memories: [] }
  }
  const memories = await loadBoundedCollection<Memory>({
    maxRows: MAX_MEMORIES,
    fetchPage: (from, to) => {
      let query = client.from('memories')
        .select('id, content, topic, sensitive, created_at, updated_at')
        .eq('user_id', userId)
      if (!preferences.sensitiveEnabled) query = query.eq('sensitive', false)
      return query.order('updated_at', { ascending: false }).range(from, to)
    },
    map: value => {
      const memory = isRecord(value) ? value : {}
      return {
        id: String(memory.id),
        content: typeof memory.content === 'string' ? memory.content : '',
        topic: typeof memory.topic === 'string' ? memory.topic : 'General',
        ...(memory.sensitive === true ? { sensitive: true } : {}),
        timestamp: typeof memory.updated_at === 'string'
          ? memory.updated_at
          : typeof memory.created_at === 'string' ? memory.created_at : undefined,
      }
    },
    unavailableMessage: '记忆上下文暂时不可用',
  })
  return { ...preferences, memories }
}

export async function loadMemoryPreferences(client: SupabaseClient, userId: string): Promise<MemoryPreferences> {
  const { data, error } = await client.from('profiles').select('memory_enabled,sensitive_memory_enabled')
    .eq('user_id', userId).maybeSingle()
  if (error) throw new AuthoritativeContextError('CONTEXT_UNAVAILABLE', '记忆上下文暂时不可用')
  return {
    enabled: data?.memory_enabled !== false,
    sensitiveEnabled: data?.sensitive_memory_enabled === true,
  }
}
