// 路径安全校验：所有 workspace 文件操作必须经过此模块
// 禁止越权、禁止敏感文件、禁止生成目录、禁止大文件/二进制改写

import { resolve, normalize, relative, join, sep } from "path"
import { statSync, readFileSync } from "fs"

// ───────────── 禁止的路径模式 ─────────────

const FORBIDDEN_NAMES = new Set([
  ".env",
  ".env.local",
  ".env.production",
  ".env.development",
  ".env.staging",
])

const FORBIDDEN_PREFIXES = [
  ".git/",
  ".git" + sep,
  "node_modules/",
  "node_modules" + sep,
  ".next/",
  ".next" + sep,
  "dist/",
  "dist" + sep,
  "build/",
  "build" + sep,
  ".turbo/",
  ".turbo" + sep,
  "coverage/",
  "coverage" + sep,
  "__pycache__/",
  "__pycache__" + sep,
  ".cache/",
  ".cache" + sep,
  "vendor/",
  "vendor" + sep,
  "bower_components/",
  "bower_components" + sep,
]

const FORBIDDEN_SUFFIXES = [
  ".pem",
  ".key",
  ".p12",
  ".pfx",
  ".jks",
  ".keystore",
  ".secret",
]

const MAX_FILE_SIZE = 2 * 1024 * 1024 // 2 MB
const BINARY_CHECK_SIZE = 512 // 前 512 字节检测二进制

// ───────────── 敏感内容正则 ─────────────

const SENSITIVE_PATTERNS = [
  /(?:sk-[a-zA-Z0-9]{20,})/g,                    // OpenAI / Anthropic API key
  /(?:AIza[0-9A-Za-z\-_]{35})/g,                 // Google API key
  /(?:gh[po]_[a-zA-Z0-9]{36})/g,                  // GitHub PAT
  /(?:-----BEGIN(?: RSA| EC| DSA| OPENSSH)? PRIVATE KEY-----[\s\S]*?-----END.*PRIVATE KEY-----)/g,
  /(?:Authorization\s*[:=]\s*Bearer\s+\S+)/gi,
  /(?:password\s*[:=]\s*["'][^"']{4,}["'])/gi,
  /(?:secret\s*[:=]\s*["'][^"']{4,}["'])/gi,
  /(?:token\s*[:=]\s*["'][^"']{8,}["'])/gi,
  /(?:DATABASE_URL\s*=\s*[^\n]{10,})/g,
  /(?:NEXT_PUBLIC_SUPABASE_ANON_KEY\s*=\s*[^\n]{10,})/g,
]

// ───────────── 校验结果 ─────────────

export type PathCheck = {
  ok: boolean
  error?: string
  normalized?: string   // 规范化后的相对路径
  absolute?: string     // workspace 内的绝对路径
}

// ───────────── 二进制检测 ─────────────

export function isBinaryFile(absPath: string): boolean {
  try {
    const buf = readFileSync(absPath)
    if (buf.length === 0) return false
    const chunk = buf.subarray(0, Math.min(BINARY_CHECK_SIZE, buf.length))
    for (let i = 0; i < chunk.length; i++) {
      if (chunk[i] === 0) return true // null byte → binary
    }
    return false
  } catch {
    return false
  }
}

// ───────────── 文件大小检查 ─────────────

export function fileTooBig(absPath: string, maxBytes = MAX_FILE_SIZE): boolean {
  try {
    return statSync(absPath).size > maxBytes
  } catch {
    return false
  }
}

export function fileSize(absPath: string): number {
  try {
    return statSync(absPath).size
  } catch {
    return 0
  }
}

// ───────────── 敏感内容打码 ─────────────

export function redactSensitive(text: string): string {
  let out = text
  for (const pattern of SENSITIVE_PATTERNS) {
    out = out.replace(pattern, (match) => {
      if (match.length <= 8) return "***"
      return match.slice(0, 4) + "…" + match.slice(-4)
    })
  }
  return out
}

// ───────────── 路径校验 ─────────────

export function validatePath(
  workspacePath: string,  // workspace 根目录绝对路径
  rawPath: string,         // 用户传入的相对路径
): PathCheck {
  // 1) 基本清洗
  const trimmed = rawPath.trim()
  if (!trimmed) return { ok: false, error: "路径为空" }

  // 2) 绝对路径拒绝
  if (trimmed.startsWith("/") || trimmed.startsWith(sep)) {
    return { ok: false, error: `不允许使用绝对路径：${trimmed}` }
  }

  // 3) 路径穿越拒绝
  if (trimmed.includes("..")) {
    return { ok: false, error: `路径包含 ".."，禁止穿越：${trimmed}` }
  }

  // 4) 空字节拒绝
  if (trimmed.includes("\0")) {
    return { ok: false, error: "路径包含空字节" }
  }

  // 5) 规范化
  const normalized = normalize(trimmed).replace(/^[/\\]+/, "")

  // 6) 再次检查穿越（normalize 可能合并 ..）
  if (normalized.includes("..")) {
    return { ok: false, error: `路径经过规范化后仍包含 ".."：${normalized}` }
  }

  // 7) 解析出 workspace 内绝对路径
  const absolute = resolve(workspacePath, normalized)

  // 8) 确保仍在 workspace 内
  const rel = relative(workspacePath, absolute)
  if (rel.startsWith("..") || rel.startsWith(sep)) {
    return { ok: false, error: `路径越权：${trimmed} → 解析到 workspace 外部` }
  }

  // 9) 禁止文件名检查
  const segments = normalized.split(/[/\\]/)
  for (const seg of segments) {
    if (FORBIDDEN_NAMES.has(seg)) {
      return { ok: false, error: `禁止访问文件：${seg}` }
    }
  }

  // 10) 禁止前缀（如 .git/、node_modules/）
  const lowerRel = rel.toLowerCase()
  for (const prefix of FORBIDDEN_PREFIXES) {
    if (lowerRel.startsWith(prefix.toLowerCase())) {
      return { ok: false, error: `禁止访问生成/系统目录：${rel}` }
    }
  }

  // 11) 禁止后缀（密钥文件）
  const lowerName = segments[segments.length - 1]?.toLowerCase() ?? ""
  for (const suffix of FORBIDDEN_SUFFIXES) {
    if (lowerName.endsWith(suffix)) {
      return { ok: false, error: `禁止访问密钥文件：${rel}` }
    }
  }

  return { ok: true, normalized, absolute }
}

// ───────────── 批量路径校验（用于 delete / patch 多文件）─────────────

export function validateMultiplePaths(
  workspacePath: string,
  rawPaths: string[],
): { ok: true; checks: PathCheck[] } | { ok: false; error: string } {
  const checks: PathCheck[] = []
  for (const p of rawPaths) {
    const chk = validatePath(workspacePath, p)
    if (!chk.ok) return { ok: false, error: chk.error! }
    checks.push(chk)
  }
  return { ok: true, checks }
}

// ───────────── 高危删除阈值 ─────────────

const DELETE_MAX_FILES = 10

export function checkDeleteThreshold(
  fileCount: number,
  paths: string[],
): { ok: boolean; reason?: string } {
  if (fileCount > DELETE_MAX_FILES) {
    return {
      ok: false,
      reason: `一次最多删除 ${DELETE_MAX_FILES} 个文件，你的请求包含 ${fileCount} 个文件：${paths.slice(0, 5).join("、")}${paths.length > 5 ? ` 等` : ""}`,
    }
  }
  return { ok: true }
}
