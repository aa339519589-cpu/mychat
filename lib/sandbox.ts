import { execSync } from 'child_process'
import { writeFileSync, mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const ALLOWED_COMMANDS = [
  'node', 'node --check', 'node -e',
  'python3', 'python3 -c',
  'npm', 'npx',
  'ls', 'cat', 'grep', 'find', 'head', 'tail', 'wc', 'echo',
]

const TIMEOUT_MS = 15_000
const MAX_OUTPUT_LENGTH = 50_000

export interface SandboxResult {
  stdout: string
  stderr: string
  exitCode: number | null
  error: string | null
  timedOut: boolean
}

export function runInSandbox(command: string, files?: Record<string, string>): SandboxResult {
  // 检查命令是否合法
  const cmdTrimmed = command.trim()
  const isAllowed = ALLOWED_COMMANDS.some(prefix => cmdTrimmed.startsWith(prefix))
  if (!isAllowed) {
    // 更宽松：允许 node / python3 / npm 开头的任何命令
    const reallyAllowed = /^(node|python3|npm|npx|ls|cat|grep|find|head|tail|wc|echo)\b/.test(cmdTrimmed)
    if (!reallyAllowed) {
      return { stdout: '', stderr: '', exitCode: null, error: `命令不允许：${cmdTrimmed}`, timedOut: false }
    }
  }

  let tmpDir: string | null = null
  try {
    // 如果有文件要写入，建临时目录
    if (files && Object.keys(files).length > 0) {
      tmpDir = mkdtempSync(join(tmpdir(), 'sandbox-'))
      for (const [path, content] of Object.entries(files)) {
        const fullPath = join(tmpDir, path)
        const dir = fullPath.substring(0, fullPath.lastIndexOf('/'))
        if (dir !== fullPath) {
          try { mkdtempSync(dir) } catch { /* 目录已存在 */ }
        }
        writeFileSync(fullPath, content, 'utf-8')
      }
    }

    const startTime = Date.now()
    const buf = execSync(cmdTrimmed, {
      cwd: tmpDir ?? undefined,
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_LENGTH,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const stdout = buf.toString('utf-8')
    const elapsed = Date.now() - startTime

    return {
      stdout: stdout.slice(0, MAX_OUTPUT_LENGTH),
      stderr: '',
      exitCode: 0,
      error: null,
      timedOut: false,
    }
  } catch (err: any) {
    const timedOut = err?.killed === true || err?.signal === 'SIGTERM'
    let stdout = ''
    let stderr = ''
    let exitCode: number | null = null

    if (err?.stdout) stdout = String(err.stdout).slice(0, MAX_OUTPUT_LENGTH)
    if (err?.stderr) stderr = String(err.stderr).slice(0, MAX_OUTPUT_LENGTH)
    if (err?.status !== undefined) exitCode = err.status

    return {
      stdout,
      stderr,
      exitCode,
      error: timedOut ? `执行超时（${TIMEOUT_MS}ms）` : err?.message ?? '执行失败',
      timedOut,
    }
  } finally {
    if (tmpDir) {
      try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* 清理失败静默 */ }
    }
  }
}
