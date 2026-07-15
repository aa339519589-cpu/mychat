import { redactSensitive } from './path-security'
import { classifyFileRisk } from './risk'

export type PublicationFile = {
  path: string
  content?: string | null
}

export type PublicationSafety =
  | { ok: true }
  | { ok: false; reason: string; path: string }

/**
 * Validate untrusted files before any irreversible repository side effect.
 * This deliberately blocks rather than redacts: redaction is suitable for
 * logs, never for silently changing source that a user is about to publish.
 */
export function assessInitialRepositoryPublication(
  files: readonly PublicationFile[],
): PublicationSafety {
  const paths = files.map(file => file.path)
  const risk = classifyFileRisk(paths)
  if (risk.blocked) {
    return {
      ok: false,
      path: risk.files[0] ?? paths[0] ?? 'unknown',
      reason: risk.reason || '发布包含关键安全文件',
    }
  }
  for (const file of files) {
    if (typeof file.content !== 'string') continue
    if (file.content.includes('\0')) {
      return { ok: false, path: file.path, reason: `文件包含二进制空字节：${file.path}` }
    }
    if (redactSensitive(file.content) !== file.content) {
      return { ok: false, path: file.path, reason: `文件疑似包含密钥或凭据：${file.path}` }
    }
  }
  return { ok: true }
}
