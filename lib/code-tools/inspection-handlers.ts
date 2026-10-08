import { listWorkspaceFiles, readWorkspaceFile } from '@/lib/agent/workspace'
import { runInWorkspace } from '@/lib/agent/shell'
import { agentExecutionBackend } from '@/lib/agent/execution-policy'
import { redactSensitive } from '@/lib/agent/path-security'
import { commandOutput } from './format'
import type { CodeToolContext, ToolHandlers, ToolParams } from './executor-types'

export function workspaceGlob(pattern: string): RegExp {
  if (!pattern || pattern.length > 128 || pattern.startsWith('/') || pattern.includes('\0')
    || pattern.split('/').includes('..') || (pattern.match(/[?*]/g)?.length ?? 0) > 12) {
    throw new Error('pattern 必须是 workspace 内的相对文件模式')
  }
  let expression = ''
  for (let index = 0; index < pattern.length; index++) {
    const value = pattern[index]
    if (value === '*' && pattern[index + 1] === '*') {
      if (pattern[index + 2] === '/') { expression += '(?:.*/)?'; index += 2 }
      else { expression += '.*'; index++ }
    } else if (value === '*') expression += '[^/]*'
    else if (value === '?') expression += '[^/]'
    else expression += value.replace(/[\\^$+.[\]{}()|]/g, '\\$&')
  }
  return new RegExp(`^${expression}$`)
}

export function codeLineRange(content: string, start: number, count: number): string {
  const first = Number.isFinite(start) ? Math.max(1, Math.floor(start)) : 1
  const length = Number.isFinite(count) ? Math.min(400, Math.max(1, Math.floor(count))) : 120
  const lines = redactSensitive(content).split('\n')
  if (first > lines.length) return `文件只有 ${lines.length} 行，请使用有效的起始行号。`
  const last = Math.min(lines.length, first + length - 1)
  const selected = lines.slice(first - 1, last).map((line, index) =>
    `${first + index}: ${line.slice(0, 2_000)}${line.length > 2_000 ? '（本行已截断）' : ''}`)
  const output = `总计 ${lines.length} 行；本次第 ${first}–${last} 行\n${selected.join('\n')}`
  return output.length > 48_000 ? output.slice(0, 48_000) + '\n（输出已截断，请缩小读取范围）' : output
}

function findFiles(context: CodeToolContext, params: ToolParams): string {
  if (!context.wsReady) return 'find_files 需要已就绪的云端 workspace。'
  try {
    const matcher = workspaceGlob(String(params.pattern ?? ''))
    const result = listWorkspaceFiles(context.wsTaskId, context.wsUserId, undefined, 10_000)
    if (!result.ok) return result.error
    const found = result.data.files.filter(path => matcher.test(path))
    context.emit({ step: { kind: 'list', label: '查找项目文件' } })
    return JSON.stringify({ files: found.slice(0, 200), matches: found.length,
      truncated: result.data.truncated || found.length > 200 })
  } catch (error) { return error instanceof Error ? error.message : '文件模式无效' }
}

function readLines(context: CodeToolContext, params: ToolParams): string {
  if (!context.wsReady) return 'read_file_lines 需要已就绪的云端 workspace。'
  const path = String(params.path ?? '').trim()
  const result = readWorkspaceFile(context.wsTaskId, context.wsUserId, path)
  if (!result.ok) return result.error
  context.emit({ step: { kind: 'read', label: `读取 ${path}` } })
  return codeLineRange(result.data.content, Number(params.start_line ?? 1), Number(params.line_count ?? 120))
}

async function cloudInspection(context: CodeToolContext, command: string, label: string): Promise<string> {
  if (!context.canExecute || !context.wsReady || !context.supabase || agentExecutionBackend() !== 'isolated') {
    return '需要已就绪的云端隔离沙箱；不会在用户设备或后端主机执行命令。'
  }
  context.emit({ step: { kind: 'read', label } })
  const remaining = context.sandboxTimeoutMs?.()
  return commandOutput(await runInWorkspace(context.supabase, context.wsUserId, context.wsTaskId,
    command, { repoIsPrivate: context.repoIsPrivate, maxOutputChars: 8_000, signal: context.signal,
      timeoutMs: Math.max(1, Math.min(30_000, remaining ?? 30_000)) }))
}

export function createCodeInspectionHandlers(context: CodeToolContext): ToolHandlers {
  return {
    find_files: params => findFiles(context, params),
    read_file_lines: params => readLines(context, params),
    inspect_environment: () => cloudInspection(context,
      'pwd && node --version && python3 --version && git --version', '检查云端运行环境'),
    git_status: () => cloudInspection(context, 'git status --short --branch', '检查 Git 状态'),
  }
}
