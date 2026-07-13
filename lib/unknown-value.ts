export type UnknownRecord = Record<string, unknown>

export function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function errorMessage(value: unknown, fallback = '未知错误'): string {
  if (value instanceof Error && value.message) return value.message
  if (isRecord(value) && typeof value.message === 'string' && value.message) return value.message
  return fallback
}

export function errorCode(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  return typeof value.code === 'string' ? value.code : undefined
}

export function recordText(value: unknown, key: string): string {
  if (!isRecord(value)) return ''
  const field = value[key]
  return field === undefined || field === null ? '' : String(field)
}
