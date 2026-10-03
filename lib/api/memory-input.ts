import { isRecord } from '@/lib/unknown-value'

export const MAX_MEMORY_CONTENT_LENGTH = 20_000
export const MAX_MEMORY_TOPIC_LENGTH = 80
export const MAX_MEMORY_IMPORT_ENTRIES = 100

export type MemoryInput = { content: string; topic: string }

export function normalizeMemoryTopic(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return 'General'
  if (typeof value !== 'string') return null
  const normalized = value.normalize('NFC').replace(/\s+/gu, ' ').trim()
  if (!normalized || normalized.length > MAX_MEMORY_TOPIC_LENGTH || /[\u0000-\u001f\u007f]/u.test(normalized)) return null
  return normalized
}

export function parseMemoryInput(value: unknown): MemoryInput | null {
  if (!isRecord(value) || typeof value.content !== 'string') return null
  const content = value.content.trim()
  const topic = normalizeMemoryTopic(value.topic)
  if (!content || content.length > MAX_MEMORY_CONTENT_LENGTH || !topic) return null
  return { content, topic }
}

export function parseMemoryImportInput(value: unknown): MemoryInput[] | null {
  if (!isRecord(value) || !Array.isArray(value.memories)
    || value.memories.length < 1 || value.memories.length > MAX_MEMORY_IMPORT_ENTRIES) return null

  const parsed = value.memories.map(parseMemoryInput)
  if (parsed.some(memory => memory === null)) return null
  const seen = new Set<string>()
  const unique: MemoryInput[] = []
  for (const memory of parsed) {
    if (!memory) continue
    const key = `${memory.topic.normalize('NFC').toLocaleLowerCase()}\u0000${memory.content.normalize('NFC')}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(memory)
  }
  return unique.length > 0 ? unique : null
}

export function isMemoryId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}
