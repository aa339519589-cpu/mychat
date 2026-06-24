import { NextRequest } from 'next/server'
import { exec } from 'child_process'
import { promisify } from 'util'
import { mkdtemp, writeFile, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

const execAsync = promisify(exec)

const ALLOWED_COMMANDS = [
  'node', 'python3', 'python', 'npm', 'npx',
  'ls', 'cat', 'grep', 'find', 'head', 'tail',
  'echo', 'wc', 'sort', 'uniq', 'cut',
  'pwd', 'which', 'env',
]

const TIMEOUT_MS = 15_000
const MAX_OUTPUT = 100_000  // 100KB

function isAllowed(command: string): boolean {
  const first = command.trim().split(/\s+/)[0]?.split('/')?.pop() ?? ''
  return ALLOWED_COMMANDS.includes(first)
}

export async function POST(req: NextRequest) {
  const { command, files } = await req.json().catch(() => ({}))
  if (!command || typeof command !== 'string') {
    return Response.json({ error: '缺少 command' }, { status: 400 })
  }

  if (!isAllowed(command)) {
    return Response.json({ error: `命令不被允许：${command.split(/\s+/)[0]}` }, { status: 403 })
  }

  let tmpDir: string | null = null
  try {
    if (files && Array.isArray(files) && files.length > 0) {
      tmpDir = await mkdtemp(join(tmpdir(), 'code-sandbox-'))
      for (const f of files) {
        const filePath = join(tmpDir, f.path)
        if (!filePath.startsWith(tmpDir)) continue
        await writeFile(filePath, f.content, 'utf-8')
      }
    }

    const cwd = tmpDir ?? process.cwd()
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT,
      env: { ...process.env, PATH: process.env.PATH },
    })

    return Response.json({
      stdout: stdout.slice(0, MAX_OUTPUT),
      stderr: stderr.slice(0, MAX_OUTPUT),
      exitCode: 0,
    })
  } catch (err: any) {
    if (err.killed || err.signal === 'SIGTERM') {
      return Response.json({
        error: '执行超时（15 秒）',
        stdout: err.stdout?.slice(0, MAX_OUTPUT) ?? '',
        stderr: err.stderr?.slice(0, MAX_OUTPUT) ?? '',
      })
    }
    return Response.json({
      stdout: err.stdout?.slice(0, MAX_OUTPUT) ?? '',
      stderr: err.stderr?.slice(0, MAX_OUTPUT) ?? (err.message ?? '未知错误'),
      exitCode: err.code ?? 1,
    })
  } finally {
    if (tmpDir) {
      rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    }
  }
}
