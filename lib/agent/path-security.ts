// Workspace 路径安全：所有文件操作必须在 workspace 根目录内。
// 防止 path traversal（../../.env）和绝对路径绕过。

import { resolve, normalize, relative } from "path"

// 校验 path 是否在 root 目录内，返回解析后的绝对路径。不合法返回 null。
export function safeResolve(root: string, userPath: string): string | null {
  if (!userPath || typeof userPath !== "string") return null

  // 拒绝绝对路径
  if (userPath.startsWith("/") || /^[A-Z]:[\\/]/i.test(userPath)) return null

  // 标准化后 resolve
  const normalized = normalize(userPath)
  const resolved = resolve(root, normalized)

  // 拒绝 ../ 绕过
  const rel = relative(root, resolved)
  if (!rel || rel.startsWith("..") || resolve(rel) !== rel) return null

  return resolved
}

// 校验并读取路径列表，所有路径必须安全
export function safeResolveAll(root: string, paths: string[]): (string | null)[] {
  return paths.map(p => safeResolve(root, p))
}

// 排除规则
export const EXCLUDED_PATTERNS = [
  /^\.git(\/|$)/,
  /^node_modules(\/|$)/,
  /^\.next(\/|$)/,
  /^dist(\/|$)/,
  /^build(\/|$)/,
  /^\.vercel(\/|$)/,
  /^\.turbo(\/|$)/,
  /^__pycache__(\/|$)/,
  /\.pyc$/,
  /\.class$/,
  /\.o$/,
  /\.so$/,
  /\.dylib$/,
  /\.dll$/,
  /\.exe$/,
  /\.bin$/,
  /\.zip$/,
  /\.tar$/,
  /\.gz$/,
  /\.png$/,
  /\.jpg$/,
  /\.jpeg$/,
  /\.gif$/,
  /\.ico$/,
  /\.woff2?$/,
  /\.ttf$/,
  /\.eot$/,
  /\.mp4$/,
  /\.mp3$/,
  /\.pdf$/,
]

// 最大文件大小（跳过分析大文件）
export const MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024 // 2MB

// 检查路径是否应被排除
export function isExcluded(relativePath: string): boolean {
  return EXCLUDED_PATTERNS.some(p => p.test(relativePath))
}

// 检查文件扩展名是否可能是文本文件（用于 read 等操作）
export function isTextFile(name: string): boolean {
  const ext = (name.split(".").pop() ?? "").toLowerCase()
  const textExts = [
    "ts", "tsx", "js", "jsx", "json", "md", "mdx", "css", "scss", "less",
    "html", "htm", "xml", "svg", "yml", "yaml", "toml", "ini", "cfg",
    "py", "rb", "go", "rs", "java", "c", "cpp", "h", "hpp", "cs",
    "sh", "bash", "zsh", "fish", "ps1", "bat", "cmd",
    "txt", "log", "env", "example", "sample",
    "sql", "graphql", "prisma",
    "vue", "svelte", "astro",
    "mjs", "cjs", "mts", "cts",
    "gitignore", "dockerignore", "editorconfig", "eslintrc", "prettierrc",
    "Dockerfile", "Makefile", "LICENSE", "README",
  ]
  return textExts.includes(ext) || !ext.includes(".")
}

// 从 path 中提取文件名（不含路径前缀）
export function basename(p: string): string {
  return p.split("/").pop() ?? p
}
