import type { Memory } from '@/lib/memory-data'
import type { SupabaseClient } from '@/lib/supabase/types'

const MAX_SHARED_MEMORY_ENTRIES = 40
const MAX_SHARED_MEMORY_CHARS = 12_000

export type SharedUserMemoryContext = {
  memories: Memory[]
  memoryEnabled: boolean
  sensitiveMemoryEnabled: boolean
}

async function loadSharedMemoryRows(
  client: SupabaseClient,
  userId: string,
  sensitiveMemoryEnabled: boolean,
): Promise<Array<{ id: string; content: string; topic: string | null; sensitive: boolean; updated_at: string }> | null> {
  let query = client.from('memories')
    .select('id,content,topic,sensitive,updated_at')
    .eq('user_id', userId)
    .eq('enabled', true)
  if (!sensitiveMemoryEnabled) query = query.eq('sensitive', false)
  const result = await query.order('updated_at', { ascending: false }).limit(MAX_SHARED_MEMORY_ENTRIES)
  return result.error || !Array.isArray(result.data) ? null : result.data
}

function mapSharedMemories(
  rows: Array<{ id: string; content: string; topic: string | null; sensitive: boolean; updated_at: string }>,
): Memory[] {
  let remainingChars = MAX_SHARED_MEMORY_CHARS
  const memories: Memory[] = []
  for (const value of rows) {
    if (remainingChars <= 0 || typeof value.content !== 'string') break
    const content = value.content.trim().slice(0, remainingChars)
    if (!content) continue
    remainingChars -= content.length
    memories.push({
      id: String(value.id), content,
      topic: typeof value.topic === 'string' && value.topic.trim() ? value.topic.trim() : 'General',
      ...(value.sensitive ? { sensitive: true } : {}),
      ...(typeof value.updated_at === 'string' ? { timestamp: value.updated_at } : {}),
    })
  }
  return memories
}

/** Loads account Memory for cloud work surfaces while respecting account consent. */
export async function loadSharedUserMemoryContext(
  client: SupabaseClient,
  userId: string,
): Promise<SharedUserMemoryContext> {
  const preferences = await client.from('profiles')
    .select('memory_enabled,sensitive_memory_enabled')
    .eq('user_id', userId)
    .maybeSingle()
  if (preferences.error) {
    return { memories: [], memoryEnabled: false, sensitiveMemoryEnabled: false }
  }

  const memoryEnabled = preferences.data?.memory_enabled !== false
  const sensitiveMemoryEnabled = preferences.data?.sensitive_memory_enabled === true
  if (!memoryEnabled) return { memories: [], memoryEnabled, sensitiveMemoryEnabled }

  const rows = await loadSharedMemoryRows(client, userId, sensitiveMemoryEnabled)
  if (!rows) {
    return { memories: [], memoryEnabled, sensitiveMemoryEnabled }
  }
  return { memories: mapSharedMemories(rows), memoryEnabled, sensitiveMemoryEnabled }
}

export async function loadSharedUserMemories(
  client: SupabaseClient,
  userId: string,
): Promise<Memory[]> {
  return (await loadSharedUserMemoryContext(client, userId)).memories
}
