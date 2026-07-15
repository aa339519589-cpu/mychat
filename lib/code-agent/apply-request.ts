import type { PlanAction } from '@/lib/code-data'
import type { AgentConfirmationCredential } from '@/lib/agent/confirmation-plan'
import { assessInitialRepositoryPublication } from '@/lib/agent/publication-safety'

export type CodeApplyRequest = {
  repo: string | null
  actions: PlanAction[]
  message: string
  taskId?: string
  mode?: 'workspace_pr' | 'direct_push'
  confirmation?: AgentConfirmationCredential
}

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isRepository(value: string): boolean {
  if (!REPO_PATTERN.test(value)) return false
  return value.split('/').every(segment => segment !== '.' && segment !== '..')
}

/** A task's persisted repository is authoritative over untrusted request data. */
export function resolveBoundRepository(
  requested: string | null,
  bound: string | null,
): string {
  if (requested && bound && requested.toLowerCase() !== bound.toLowerCase()) {
    throw new Error('请求仓库与任务绑定仓库不一致')
  }
  const repository = bound ?? requested
  if (!repository) throw new Error('任务缺少绑定仓库')
  return repository
}

function isSafeRepositoryPath(value: string): boolean {
  if (!value || value.length > 500 || value.startsWith('/') || value.includes('\\') || /[\0-\x1f]/.test(value)) {
    return false
  }
  return value.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..' && segment !== '.git')
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error(`${field} 无效`)
  return value
}

function parseAction(value: unknown, index: number): PlanAction {
  if (!isRecord(value) || typeof value.kind !== 'string') {
    throw new Error(`actions[${index}] 格式无效`)
  }
  switch (value.kind) {
    case 'create_repo': {
      if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 100) {
        throw new Error(`actions[${index}].name 无效`)
      }
      const description = optionalString(value.description, `actions[${index}].description`)
      if (description && description.length > 350) throw new Error(`actions[${index}].description 过长`)
      if (value.private !== undefined && typeof value.private !== 'boolean') {
        throw new Error(`actions[${index}].private 无效`)
      }
      return { kind: value.kind, name: value.name, description, private: value.private as boolean | undefined }
    }
    case 'write_file':
      if (typeof value.path !== 'string' || !isSafeRepositoryPath(value.path) || typeof value.newContent !== 'string') {
        throw new Error(`actions[${index}] 文件内容无效`)
      }
      if (Buffer.byteLength(value.newContent, 'utf8') > 700_000) {
        throw new Error(`actions[${index}].newContent 过大`)
      }
      if (value.oldContent !== undefined && typeof value.oldContent !== 'string') {
        throw new Error(`actions[${index}].oldContent 无效`)
      }
      {
        const safety = assessInitialRepositoryPublication([{
          path: value.path,
          content: value.newContent,
        }])
        if (!safety.ok) throw new Error(`actions[${index}] ${safety.reason}`)
      }
      return { kind: value.kind, path: value.path, oldContent: value.oldContent ?? '', newContent: value.newContent }
    case 'delete_file':
      if (typeof value.path !== 'string' || !isSafeRepositoryPath(value.path)) {
        throw new Error(`actions[${index}].path 无效`)
      }
      {
        const safety = assessInitialRepositoryPublication([{ path: value.path, content: null }])
        if (!safety.ok) throw new Error(`actions[${index}] ${safety.reason}`)
      }
      return { kind: value.kind, path: value.path }
    case 'enable_pages':
      return { kind: value.kind }
    default:
      throw new Error(`actions[${index}].kind 无效`)
  }
}

/** Parse the untrusted apply payload before any repository or database work starts. */
export function parseCodeApplyRequest(input: unknown): CodeApplyRequest {
  if (!isRecord(input)) throw new Error('请求体格式无效')

  const repo = input.repo ?? null
  if (repo !== null && (typeof repo !== 'string' || !isRepository(repo))) {
    throw new Error('仓库参数无效')
  }

  const taskId = optionalString(input.taskId, 'taskId')
  if (taskId !== undefined && !UUID_PATTERN.test(taskId)) throw new Error('taskId 无效')

  const mode = optionalString(input.mode, 'mode')
  if (mode !== undefined && mode !== 'workspace_pr' && mode !== 'direct_push') {
    throw new Error('mode 无效')
  }

  const message = input.message ?? ''
  if (typeof message !== 'string' || message.length > 10_000) throw new Error('message 无效')

  const rawActions = input.actions ?? []
  if (!Array.isArray(rawActions)) throw new Error('actions 格式无效')
  if (rawActions.length > 100) throw new Error('actions 数量过多')

  let confirmation: AgentConfirmationCredential | undefined
  if (input.confirmationId !== undefined || input.confirmationToken !== undefined) {
    if (typeof input.confirmationId !== 'string' || !UUID_PATTERN.test(input.confirmationId)
        || typeof input.confirmationToken !== 'string'
        || !/^[A-Za-z0-9_-]{43}$/.test(input.confirmationToken)) {
      throw new Error('confirmationId/confirmationToken 必须同时提供且格式有效')
    }
    confirmation = {
      confirmationId: input.confirmationId,
      confirmationToken: input.confirmationToken,
    }
  }

  const actions = rawActions.map(parseAction)
  if (!taskId) throw new Error('taskId 必须由客户端预分配，以保证新项目请求幂等')

  return {
    repo: repo as string | null,
    actions,
    message,
    taskId,
    mode: mode as CodeApplyRequest['mode'],
    ...(confirmation ? { confirmation } : {}),
  }
}
