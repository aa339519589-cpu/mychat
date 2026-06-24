// 错误解析器：从 stderr/stdout 提取结构化错误信息

type ParsedError = {
  errorType: string
  file: string | null
  line: number | null
  column: number | null
  message: string
  likelyCause: string | null
  suggestedFilesToRead: string[]
  rawExcerpt: string
  severity: "error" | "warning"
}

export type VerificationErrors = {
  totalErrors: number
  totalWarnings: number
  errors: ParsedError[]
  summary: string
}

// ───────────── 通用提取 ─────────────

function allMatches(text: string, pattern: RegExp): RegExpExecArray[] {
  const results: RegExpExecArray[] = []
  let m: RegExpExecArray | null
  pattern.lastIndex = 0
  while ((m = pattern.exec(text)) !== null) {
    results.push(m)
    if (results.length > 100) break // safety limit
  }
  return results
}

// ───────────── TypeScript ─────────────

const TS_ERROR = /^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.+)$/gm

function parseTypeScriptErrors(text: string): ParsedError[] {
  const results: ParsedError[] = []
  for (const m of allMatches(text, TS_ERROR)) {
    const file = m[1].trim()
    results.push({
      errorType: `TS(${m[4]})`,
      file,
      line: parseInt(m[2]) || null,
      column: parseInt(m[3]) || null,
      message: m[5].trim(),
      likelyCause: tsCauseHint(m[4]),
      suggestedFilesToRead: [file],
      rawExcerpt: m[0].trim(),
      severity: "error",
    })
  }
  return results
}

function tsCauseHint(code: string): string | null {
  const hints: Record<string, string> = {
    "TS2322": "类型不匹配，检查赋值或参数类型",
    "TS2339": "属性不存在，可能拼写错误或类型定义缺失",
    "TS2345": "参数类型不匹配",
    "TS2554": "函数参数数量不对",
    "TS2304": "找不到名称，可能缺少 import",
    "TS2307": "找不到模块，检查 import 路径或 npm install",
    "TS7006": "参数隐式 any，需要添加类型注解",
    "TS2532": "对象可能为 undefined，添加空值检查",
    "TS18046": "变量可能为 null，添加 null 检查",
    "TS2551": "属性不存在于当前类型，检查类型定义",
  }
  return hints[code] ?? null
}

// ───────────── ESLint ─────────────

const ESLINT_ERROR = /^\s*(.+?):(\d+):(\d+)\s+(error|warning)\s+(.+?)\s{2,}(.+)$/gm

function parseESLintErrors(text: string): ParsedError[] {
  const results: ParsedError[] = []
  for (const m of allMatches(text, ESLINT_ERROR)) {
    results.push({
      errorType: `eslint(${m[5]})`,
      file: m[1].trim(),
      line: parseInt(m[2]) || null,
      column: parseInt(m[3]) || null,
      message: m[6]?.trim() ?? m[5]?.trim() ?? "",
      likelyCause: null,
      suggestedFilesToRead: [m[1].trim()],
      rawExcerpt: m[0].trim(),
      severity: m[4] === "warning" ? "warning" : "error",
    })
  }
  return results
}

// ───────────── Next.js Build ─────────────

const NEXT_ERROR = /^(.+?):(\d+):(\d+)\s+([✗╳✘❌])?\s*(.+)$/gm
const NEXT_MODULE = /Module not found:\s+(.+)/g

function parseNextBuildErrors(text: string): ParsedError[] {
  const results: ParsedError[] = []

  // Module not found
  for (const m of allMatches(text, NEXT_MODULE)) {
    results.push({
      errorType: "next(module-not-found)",
      file: null,
      line: null,
      column: null,
      message: `Module not found: ${m[1]}`,
      likelyCause: "缺少依赖，运行 npm install 或检查 import 路径",
      suggestedFilesToRead: [],
      rawExcerpt: m[0].trim(),
      severity: "error",
    })
  }

  // File:line:col errors
  for (const m of allMatches(text, NEXT_ERROR)) {
    const file = m[1].trim()
    const msg = m[5]?.trim() ?? ""
    // filter out noise
    if (msg.includes("Warning:") || msg.includes("Skipping")) continue
    results.push({
      errorType: "next(build)",
      file,
      line: parseInt(m[2]) || null,
      column: parseInt(m[3]) || null,
      message: msg.slice(0, 200),
      likelyCause: null,
      suggestedFilesToRead: [file],
      rawExcerpt: m[0].trim(),
      severity: "error",
    })
  }

  return results
}

// ───────────── Runtime Stack Trace ─────────────

const STACK_LINE = /at\s+(.+?)\s+\((.+?):(\d+):(\d+)\)/g

function parseRuntimeStack(text: string): ParsedError[] {
  const results: ParsedError[] = []
  const seen = new Set<string>()

  for (const m of allMatches(text, STACK_LINE)) {
    const file = m[2].trim()
    if (seen.has(file)) continue
    seen.add(file)
    results.push({
      errorType: "runtime",
      file,
      line: parseInt(m[3]) || null,
      column: parseInt(m[4]) || null,
      message: `at ${m[1].trim()}`,
      likelyCause: null,
      suggestedFilesToRead: [file],
      rawExcerpt: m[0].trim(),
      severity: "error",
    })
  }

  return results
}

// ───────────── Package / npm ─────────────

const PACKAGE_ERR = /npm ERR!\s+(.+)/g
const PACKAGE_DEP = /ERESOLVE|unable to resolve dependency/i

function parsePackageErrors(text: string): ParsedError[] {
  const msgs: string[] = []
  for (const m of allMatches(text, PACKAGE_ERR)) {
    msgs.push(m[1].trim())
  }
  if (!msgs.length) return []

  return [{
    errorType: "npm",
    file: null,
    line: null,
    column: null,
    message: msgs.join("; ").slice(0, 300),
    likelyCause: PACKAGE_DEP.test(text) ? "依赖冲突，尝试 npm install --legacy-peer-deps 或更新依赖版本" : "npm 错误，检查 package.json 和网络",
    suggestedFilesToRead: ["package.json"],
    rawExcerpt: msgs.slice(0, 5).join("\n"),
    severity: "error",
  }]
}

// ───────────── 通用 ─────────────

const GENERIC_FILE_LINE = /^(.+?):(\d+):(\d+):\s*(.+)$/gm
const GENERIC_FILE_LINE2 = /^(.+?):(\d+):\s*(.+)$/gm

function parseGenericErrors(text: string): ParsedError[] {
  const results: ParsedError[] = []
  for (const m of allMatches(text, GENERIC_FILE_LINE)) {
    const file = m[1].trim()
    const msg = m[4].trim()
    results.push({
      errorType: "unknown",
      file,
      line: parseInt(m[2]) || null,
      column: parseInt(m[3]) || null,
      message: msg.slice(0, 200),
      likelyCause: null,
      suggestedFilesToRead: [file],
      rawExcerpt: m[0].trim(),
      severity: "error",
    })
  }
  for (const m of allMatches(text, GENERIC_FILE_LINE2)) {
    const file = m[1].trim()
    const msg = m[3].trim()
    if (results.some(r => r.file === file)) continue // dedup
    results.push({
      errorType: "unknown",
      file,
      line: parseInt(m[2]) || null,
      column: null,
      message: msg.slice(0, 200),
      likelyCause: null,
      suggestedFilesToRead: [file],
      rawExcerpt: m[0].trim(),
      severity: "error",
    })
  }
  return results
}

// ───────────── 主入口 ─────────────

export function parseAllErrors(
  stdout: string,
  stderr: string,
  command: string,
): VerificationErrors {
  const combined = [stderr, stdout].join("\n")
  let allErrors: ParsedError[] = []

  // 按命令类型选择解析器
  if (/tsc|typescript|\.tsx?/.test(command) || /TS\d+/.test(combined)) {
    allErrors.push(...parseTypeScriptErrors(combined))
  }
  if (/eslint|biome|lint/.test(command) || /error|warning\s{2,}/.test(stderr)) {
    allErrors.push(...parseESLintErrors(combined))
  }
  if (/next\s|next\.config|Failed to compile/.test(combined)) {
    allErrors.push(...parseNextBuildErrors(combined))
  }
  if (/npm ERR|ERESOLVE|unable to resolve/.test(combined)) {
    allErrors.push(...parsePackageErrors(combined))
  }
  const stackErrors = parseRuntimeStack(combined)
  if (stackErrors.length) allErrors.push(...stackErrors)

  // 如果还没解析出任何错误，用通用解析
  if (allErrors.length === 0 && combined.trim()) {
    allErrors = parseGenericErrors(combined)
  }

  // 如果没有结构性错误但有输出，捕获摘要
  if (allErrors.length === 0 && combined.trim()) {
    allErrors.push({
      errorType: "unknown",
      file: null, line: null, column: null,
      message: combined.slice(0, 500),
      likelyCause: null,
      suggestedFilesToRead: [],
      rawExcerpt: combined.slice(0, 1000),
      severity: "error",
    })
  }

  const errors = allErrors.filter(e => e.severity === "error")
  const warnings = allErrors.filter(e => e.severity === "warning")

  return {
    totalErrors: errors.length,
    totalWarnings: warnings.length,
    errors: allErrors,
    summary: errors.length > 0
      ? `${errors.length} 个错误，${warnings.length} 个警告：\n${errors.slice(0, 10).map(e => `  ${e.file ?? "?"}:${e.line ?? "?"} - ${e.message.slice(0, 80)}`).join("\n")}`
      : warnings.length > 0
        ? `${warnings.length} 个警告（无错误）`
        : "",
  }
}
