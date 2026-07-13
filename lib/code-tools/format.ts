export function commandOutput(result: {
  stdout?: string
  stderr?: string
  error?: string | null
  exitCode?: number | null
  timedOut?: boolean
  blocked?: boolean
  blockedReason?: string
}): string {
  if (result.blocked) return `命令被拦截：${result.blockedReason}`
  const output = [
    result.stdout && `标准输出：\n${result.stdout}`,
    result.stderr && `标准错误：\n${result.stderr}`,
    result.error && `错误：${result.error}`,
    result.timedOut && '命令执行超时',
    result.exitCode && `退出码：${result.exitCode}`,
  ].filter(Boolean)
  return output.join('\n') || '执行完成（无输出）'
}

