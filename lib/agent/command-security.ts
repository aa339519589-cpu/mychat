// 命令安全拦截：禁止危险命令、环境变量泄露、路径逃逸。
// 返回 { allowed: true } 或 { allowed: false, reason: "..." }

// ── 危险命令黑名单 ──

const BLOCKED_PATTERNS: { pattern: RegExp; reason: string }[] = [
  // 系统破坏
  { pattern: /rm\s+-rf\s+\/\s*(\*|$|;|\||&)/i, reason: "禁止 rm -rf /" },
  { pattern: /rm\s+-rf\s+\*\s*$/i, reason: "禁止危险删除命令" },
  { pattern: /\bsudo\b/i, reason: "禁止提权命令 sudo" },
  { pattern: /\bsu\b\s+-/i, reason: "禁止切换用户 su" },
  { pattern: /\bchmod\s+777\b/, reason: "禁止 chmod 777" },
  { pattern: /\bchown\b/i, reason: "禁止 chown" },
  { pattern: /\bmkfs\b/i, reason: "禁止 mkfs" },
  { pattern: /\bdd\s+if=/i, reason: "禁止 dd 磁盘操作" },
  // fork bomb
  { pattern: /:\s*\(\s*\)\s*{\s*:\s*\|\s*:\s*&\s*}\s*;?\s*:/, reason: "禁止 fork bomb" },
  // curl/wget pipe to shell
  { pattern: /\bcurl\b.+\|\s*(ba)?sh\b/i, reason: "禁止 curl 管道执行 shell" },
  { pattern: /\bwget\b.+\|\s*(ba)?sh\b/i, reason: "禁止 wget 管道执行 shell" },
  { pattern: /\bbash\s*<\s*\(\s*curl\b/i, reason: "禁止 bash <(curl) 执行" },
  // 敏感文件读取
  { pattern: /\bcat\s+(\.env|\.env\.[^ ]+)\b/, reason: "禁止读取 .env 文件" },
  { pattern: /\b(read|cat|less|more|head|tail|grep|strings|hexdump)\s+.*\.env\b/, reason: "禁止读取 .env 文件" },
  // 环境变量泄露
  { pattern: /\bprintenv\b/, reason: "禁止输出环境变量" },
  { pattern: /^\s*env\s*$/, reason: "禁止输出完整环境变量" },
  // Git 破坏性推送
  { pattern: /\bgit\s+push\s+(-f|--force)\b/, reason: "禁止 git push --force" },
  { pattern: /\bgit\s+push\s+origin\s+(main|master)\s+(-f|--force-)/, reason: "禁止强制推送主分支" },
  { pattern: /\bgit\s+push\s+origin\s+(main|master)\s*$/i, reason: "禁止直接推送 main/master" },
  // 系统文件访问
  { pattern: /\/etc\//, reason: "禁止访问系统目录 /etc" },
  { pattern: /\/root\//, reason: "禁止访问 /root" },
  { pattern: /\/var\/run\/docker\.sock/, reason: "禁止访问 Docker socket" },
  // 绝对路径删除（大量文件）
  { pattern: /\brm\s+-rf\s+\/tmp\//, reason: "禁止删除临时目录" },
  { pattern: /\brm\s+-rf\s+\/[a-z]/, reason: "禁止绝对路径删除" },
  // 环境变量注入
  { pattern: /\bDEEPSEEK_API_KEY\b/i, reason: "禁止访问 API 密钥" },
  { pattern: /\bMIMO_API_KEY\b/i, reason: "禁止访问 API 密钥" },
  { pattern: /\bTAVILY_API_KEY\b/i, reason: "禁止访问 API 密钥" },
  { pattern: /\bGH_TOKEN\b/, reason: "禁止访问 GitHub Token" },
  { pattern: /\bNEXT_PUBLIC_SUPABASE/i, reason: "禁止访问 Supabase 密钥" },
]

// ── 允许命令白名单模式（更安全）──

const ALLOWED_COMMANDS: RegExp[] = [
  /^git\s+(status|diff|branch|log|stash|add|checkout|commit|merge|remote|config|rev-parse|show|restore|reset|switch)(?:\s|$)/i,
  /^node\s+(--version|-v)(?:\s|$)/i,
  /^node\s+--check\s+[^\s]+(?:\s|$)/i,
  /^npm\s+(--version|-v|ci|install|test)(?:\s|$)/i,
  /^npm\s+run\s+(build|lint|typecheck|test|start|dev)(?:\s|$)/i,
  /^pnpm\s+(--version|install|build|test|lint|typecheck)(?:\s|$)/i,
  /^yarn\s+(--version|-v|install|build|test|lint|typecheck)(?:\s|$)/i,
  /^npx\s+(tsc|eslint|vitest|jest|next|prettier)(?:\s|$)/i,
  /^(python|python3)\s+(--version|-V)(?:\s|$)/,
  /^(ls|cat|grep|rg|find|head|tail|wc|echo|sort|uniq|cut|which|whereis|du|df)(?:\s|$)/i,
]

// ── 判断函数 ──

export type SecurityVerdict =
  | { allowed: true }
  | { allowed: false; reason: string }

export function checkCommand(command: string): SecurityVerdict {
  if (!command || typeof command !== "string") {
    return { allowed: false, reason: "命令为空" }
  }

  const trimmed = command.trim()
  if (trimmed.length > 4_000) return { allowed: false, reason: "命令过长" }

  // Commands are executed through a shell in both backends. Shell grammar is
  // therefore closed entirely: one argv command, no chaining, redirection,
  // substitutions, variable expansion, or multiline payloads.
  if (/[\0\r\n;&|><`$()]/.test(trimmed)) {
    return { allowed: false, reason: "禁止 shell 连接、重定向或表达式展开" }
  }
  if (/(^|\s)\.\.\//.test(trimmed) || /(^|\s)\/[A-Za-z]/.test(trimmed)) {
    return { allowed: false, reason: "禁止命令参数逃逸 workspace" }
  }

  // 检查黑名单（危险模式）
  for (const rule of BLOCKED_PATTERNS) {
    if (rule.pattern.test(trimmed)) {
      return { allowed: false, reason: rule.reason }
    }
  }

  // 检查白名单（安全前缀）
  const allowed = ALLOWED_COMMANDS.some(pattern => pattern.test(trimmed))

  if (!allowed) {
    return { allowed: false, reason: `命令不在允许列表中：${trimmed.slice(0, 60)}` }
  }

  return { allowed: true }
}

// 清理命令输出中的敏感信息
export function sanitizeCommandOutput(text: string): string {
  if (!text) return text
  return text
    .replace(/([A-Za-z0-9+/]{40,})/g, "***TOKEN***")                     // token 格式
    .replace(/(sk-[A-Za-z0-9-_]{20,})/g, "***API_KEY***")                // sk- 前缀 key
    .replace(/(tvly-[A-Za-z0-9-_]{20,})/gi, "***API_KEY***")            // tvly- 前缀
    .replace(/(sb_publishable_[A-Za-z0-9-_]{10,})/g, "***SUPABASE***")  // supabase key
    .replace(/Authorization:\s*Bearer\s+\S+/gi, "Authorization: ***")
    .replace(/gh_access_token=[^&\s]+/gi, "gh_access_token=***")
    .replace(/(x-access-token:)[^\s@]+/gi, "$1***")
}
