import type { Memory } from '@/lib/memory-data'

type MemoryRow = {
  id: string
  content: string
  created_at?: string | null
  updated_at?: string | null
}
type MemoryApiResponse = {
  memories?: MemoryRow[]
  memory?: MemoryRow
  deleted?: number
  ok?: boolean
  error?: unknown
}

async function memoryRequest(
  path: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  body?: object,
): Promise<MemoryApiResponse> {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  let result: MemoryApiResponse = {}
  try {
    result = await response.json() as MemoryApiResponse
  } catch {
    // Keep a stable user-facing error when an intermediary returns non-JSON.
  }
  if (!response.ok) {
    throw new Error(
      typeof result.error === 'string' && result.error
        ? result.error
        : '记忆服务暂时不可用，请稍后重试',
    )
  }
  return result
}

function toMemory(row: MemoryRow): Memory {
  return {
    id: row.id,
    content: row.content,
    timestamp: row.updated_at || row.created_at || undefined,
  }
}

export async function fetchMemories(): Promise<Memory[]> {
  const result = await memoryRequest('/api/memories', 'GET')
  if (!Array.isArray(result.memories)) throw new Error('记忆服务返回的数据无效，请重试')
  return result.memories.map(toMemory)
}

export async function insertMemory(content: string): Promise<Memory> {
  const result = await memoryRequest('/api/memories', 'POST', { content })
  if (!result.memory) throw new Error('记忆保存结果无效，请重试')
  return toMemory(result.memory)
}

export async function updateMemory(id: string, content: string): Promise<void> {
  const result = await memoryRequest(`/api/memories/${encodeURIComponent(id)}`, 'PATCH', { content })
  if (!result.memory) throw new Error('记忆修改结果无效，请刷新后重试')
}

export async function deleteMemoryRow(id: string): Promise<void> {
  const result = await memoryRequest(`/api/memories/${encodeURIComponent(id)}`, 'DELETE')
  if (result.ok !== true) throw new Error('记忆删除结果无效，请刷新后重试')
}

export async function deleteAllMemories(): Promise<number> {
  const result = await memoryRequest('/api/memories', 'DELETE')
  if (typeof result.deleted !== 'number') throw new Error('记忆清除结果无效，请重试')
  return result.deleted
}
