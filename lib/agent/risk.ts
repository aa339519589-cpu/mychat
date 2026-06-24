// 风险统一判断：classifyAgentRisk, classifyFileRisk, classifyPublishRisk, requiresUserConfirmation
// 默认安全原则：高危必须停，关键直接阻断

export type RiskLevel = "low" | "medium" | "high" | "critical"

export type RiskAssessment = {
  level: RiskLevel
  blocked: boolean         // 直接阻断，不允许确认
  needsConfirmation: boolean
  reason: string
  files: string[]
  operation: string
  title: string
}

// ─── 高危路径模式 ───

const CRITICAL_PATH_PATTERNS = [
  /(^|\/)\.env(\..*)?$/,
  /(^|\/)\.env\.local$/,
  /(^|\/)\.env\.production$/,
  /(^|\/)\.env\.development$/,
  /\.pem$/,
  /\.key$/,
  /\.p12$/,
  /\.pfx$/,
  /\.jks$/,
  /\.keystore$/,
  /credentials\.(json|yml|yaml)$/i,
  /private[_-]?key/i,
  /id_rsa/,
  /id_ed25519/,
  /id_ecdsa/,
]

const HIGH_PATH_PATTERNS = [
  /(^|\/)\.github\/workflows\//,
  /(^|\/)supabase\/migrations\//,
  /package-lock\.json$/,
  /pnpm-lock\.yaml$/,
  /yarn\.lock$/,
  /auth\//i,
  /payment/i,
  /billing/i,
  /stripe/i,
  /checkout/i,
]

// ─── 文件列表风险判断 ───

export function classifyFileRisk(files: string[]): RiskAssessment {
  const blocked: string[] = []
  const high: string[] = []

  for (const f of files) {
    const matchedCritical = CRITICAL_PATH_PATTERNS.some(p => p.test(f))
    if (matchedCritical) { blocked.push(f); continue }
    const matchedHigh = HIGH_PATH_PATTERNS.some(p => p.test(f))
    if (matchedHigh) high.push(f)
  }

  if (blocked.length > 0) {
    return {
      level: "critical",
      blocked: true,
      needsConfirmation: false,
      reason: `涉及关键安全文件：${blocked.join("、")}。操作已被直接阻断。`,
      files: blocked,
      operation: "file_operation",
      title: "关键安全文件操作被阻断",
    }
  }

  if (high.length > 0) {
    return {
      level: "high",
      blocked: false,
      needsConfirmation: true,
      reason: `涉及高危文件：${high.join("、")}。需要用户确认后才能继续。`,
      files: high,
      operation: "file_operation",
      title: `高危文件操作：${high.length} 个文件`,
    }
  }

  return {
    level: "low",
    blocked: false,
    needsConfirmation: false,
    reason: "",
    files: [],
    operation: "file_operation",
    title: "",
  }
}

// ─── 删除操作风险 ───

export function classifyDeleteRisk(paths: string[], isDirectory = false): RiskAssessment {
  // 先检查文件内容风险
  const fileRisk = classifyFileRisk(paths)
  if (fileRisk.blocked || fileRisk.needsConfirmation) return fileRisk

  // 数量阈值
  if (paths.length > 5) {
    return {
      level: "high",
      blocked: false,
      needsConfirmation: true,
      reason: `一次删除 ${paths.length} 个文件，超过安全阈值（5 个）。`,
      files: paths,
      operation: "delete_files",
      title: `批量删除 ${paths.length} 个文件`,
    }
  }

  if (isDirectory) {
    return {
      level: "high",
      blocked: false,
      needsConfirmation: true,
      reason: "删除目录操作需要用户确认.",
      files: paths,
      operation: "delete_directory",
      title: "删除目录",
    }
  }

  return {
    level: "low",
    blocked: false,
    needsConfirmation: false,
    reason: "",
    files: paths,
    operation: "delete_files",
    title: "",
  }
}

// ─── Publish / PR 风险 ───

export function classifyPublishRisk(changedFiles: string[], branch: string): RiskAssessment {
  // 检查分支
  if (["main", "master"].includes(branch.toLowerCase())) {
    return {
      level: "critical",
      blocked: true,
      needsConfirmation: false,
      reason: `禁止直接推送 ${branch} 分支。请创建 agent branch 后重试。`,
      files: [],
      operation: "publish",
      title: "禁止直推 main/master",
    }
  }

  // 检查文件
  const fileRisk = classifyFileRisk(changedFiles)
  if (fileRisk.blocked) return { ...fileRisk, operation: "publish" }

  if (fileRisk.needsConfirmation) {
    return {
      ...fileRisk,
      operation: "publish",
      title: `PR 包含高危文件：${fileRisk.files.length} 个`,
    }
  }

  return {
    level: "low",
    blocked: false,
    needsConfirmation: false,
    reason: "",
    files: changedFiles,
    operation: "publish",
    title: "",
  }
}

// ─── Shell / execute 风险 ───

const DANGEROUS_COMMANDS = [
  /rm\s+-rf\s+\//,
  /sudo\s/,
  /chmod\s+777/,
  />\s*\/dev\/[a-z]+/,
  /mkfs\./,
  /dd\s+if=/,
  /:\(\)\s*\{\s*:\|:&\s*\};:/,  // fork bomb
]

export function classifyCommandRisk(command: string): RiskAssessment {
  for (const pattern of DANGEROUS_COMMANDS) {
    if (pattern.test(command)) {
      return {
        level: "critical",
        blocked: true,
        needsConfirmation: false,
        reason: `危险命令被阻断：${command.slice(0, 80)}`,
        files: [],
        operation: "execute",
        title: "危险命令被阻断",
      }
    }
  }
  return { level: "low", blocked: false, needsConfirmation: false, reason: "", files: [], operation: "execute", title: "" }
}

// ─── 统一入口 ───

export type RiskOperationType =
  | "write_file" | "edit_file" | "delete_files" | "delete_directory"
  | "apply_patch" | "publish" | "commit" | "push" | "execute"
  | "read_env" | "path_traversal" | "force_push" | "push_main" | "merge_pr"

export function classifyAgentRisk(
  operation: RiskOperationType,
  context: { files?: string[]; branch?: string; command?: string; fileCount?: number },
): RiskAssessment {
  switch (operation) {
    case "read_env":
      return { level: "critical", blocked: true, needsConfirmation: false, reason: "禁止读取 .env 文件", files: context.files ?? [], operation, title: "禁止读取 .env" }
    case "path_traversal":
      return { level: "critical", blocked: true, needsConfirmation: false, reason: "禁止路径穿越操作", files: context.files ?? [], operation, title: "禁止路径穿越" }
    case "force_push":
      return { level: "critical", blocked: true, needsConfirmation: false, reason: "禁止 force push", files: [], operation, title: "禁止 force push" }
    case "push_main":
      return { level: "critical", blocked: true, needsConfirmation: false, reason: "禁止直接推送 main/master 分支", files: [], operation, title: "禁止 push main" }
    case "merge_pr":
      return { level: "critical", blocked: true, needsConfirmation: false, reason: "Agent 不允许合并 PR", files: [], operation, title: "禁止合并 PR" }

    case "write_file":
      return classifyFileRisk(context.files ?? [])
    case "edit_file":
      return classifyFileRisk(context.files ?? [])
    case "delete_files":
      return classifyDeleteRisk(context.files ?? [])
    case "delete_directory":
      return classifyDeleteRisk(context.files ?? [], true)
    case "apply_patch":
      return classifyFileRisk(context.files ?? [])
    case "publish":
      return classifyPublishRisk(context.files ?? [], context.branch ?? "")
    case "commit":
      return classifyFileRisk(context.files ?? [])
    case "push":
      return classifyPublishRisk([], context.branch ?? "")
    case "execute":
      return classifyCommandRisk(context.command ?? "")

    default:
      return { level: "low", blocked: false, needsConfirmation: false, reason: "", files: [], operation, title: "" }
  }
}
