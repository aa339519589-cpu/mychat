type LogLevel = 'info' | 'warn' | 'error'

function formatLog(level: LogLevel, tag: string, msg: string, data?: unknown): string {
  const timestamp = new Date().toISOString()
  const dataStr = data ? ` | ${JSON.stringify(data)}` : ''
  return `[${timestamp}] [${level.toUpperCase()}] [${tag}] ${msg}${dataStr}`
}

export const log = {
  info: (tag: string, msg: string, data?: unknown) => {
    console.log(formatLog('info', tag, msg, data))
  },
  warn: (tag: string, msg: string, data?: unknown) => {
    console.warn(formatLog('warn', tag, msg, data))
  },
  error: (tag: string, msg: string, err?: unknown) => {
    const errData = err instanceof Error ? { message: err.message, stack: err.stack } : err
    console.error(formatLog('error', tag, msg, errData))
  },
}
