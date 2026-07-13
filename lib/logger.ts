type LogLevel = 'info' | 'warn' | 'error'

const MAX_STRING_LENGTH = 2_000
const MAX_DEPTH = 5
const SECRET_FIELD = /(authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|secret|password|cookie|credential)/i
const INLINE_SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [redacted]'],
  [/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}\b/g, '[redacted]'],
  [/\bsb_(?:secret|publishable)_[A-Za-z0-9_-]{8,}\b/gi, '[redacted]'],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted-jwt]'],
  [/((?:api[-_]?key|access[-_]?token|refresh[-_]?token|secret|password|cookie|credential)\s*[=:]\s*)[^\s&,;]+/gi, '$1[redacted]'],
]

function safeString(value: string): string {
  let sanitized = value
  for (const [pattern, replacement] of INLINE_SECRET_PATTERNS) {
    sanitized = sanitized.replace(pattern, replacement)
  }
  return sanitized.length > MAX_STRING_LENGTH
    ? `${sanitized.slice(0, MAX_STRING_LENGTH)}…[truncated]`
    : sanitized
}

function safeValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'string') return safeString(value)
  if (value instanceof Error) {
    return {
      name: value.name,
      message: safeValue(value.message, depth + 1, seen),
      ...(process.env.NODE_ENV !== 'production' && value.stack ? { stack: safeValue(value.stack, depth + 1, seen) } : {}),
    }
  }
  if (depth >= MAX_DEPTH) return '[max-depth]'
  if (typeof value !== 'object') return String(value)
  if (seen.has(value)) return '[circular]'
  seen.add(value)
  if (Array.isArray(value)) return value.slice(0, 100).map(item => safeValue(item, depth + 1, seen))

  const result: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    result[key] = SECRET_FIELD.test(key) ? '[redacted]' : safeValue(entry, depth + 1, seen)
  }
  return result
}

function write(level: LogLevel, tag: string, message: string, data?: unknown) {
  const payload = {
    timestamp: new Date().toISOString(),
    level,
    service: 'mychat',
    tag,
    message: safeString(message),
    ...(data === undefined ? {} : { data: safeValue(data) }),
  }
  const line = JSON.stringify(payload)
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
}

export const log = {
  info: (tag: string, message: string, data?: unknown) => write('info', tag, message, data),
  warn: (tag: string, message: string, data?: unknown) => write('warn', tag, message, data),
  error: (tag: string, message: string, error?: unknown) => write('error', tag, message, error),
}
