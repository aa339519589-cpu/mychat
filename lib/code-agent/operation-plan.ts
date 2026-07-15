import type { SupabaseClient } from '@supabase/supabase-js'
import {
  canonicalAgentOperationPlan,
  sha256,
  type AgentOperationPlan,
  type CanonicalValue,
} from '@/lib/agent/confirmation-plan'
import { parseAndVerifyManifest } from '@/lib/agent/snapshot/cas-integrity'
import type { SnapshotManifest } from '@/lib/agent/snapshot/cas-types'
import { sha256JobValue } from '@/lib/jobs/canonical'
import type { JsonObject } from '@/lib/jobs/contracts'
import type { PlanAction } from '@/lib/code-data'
import type { CodeApplyRequest } from './apply-request'
import {
  assessInitialRepositoryPublication,
  type PublicationFile,
} from '@/lib/agent/publication-safety'

export type AgentOperationKind = 'initial_repository' | 'workspace_publish'

export type AgentOperationSnapshot = {
  snapshotId: string
  manifestDigest: string
  treeDigest: string
  head: string
}

export type AgentOperationPayload = JsonObject & {
  schemaVersion: 1
  kind: AgentOperationKind
  taskId: string
  message: string
  actions: PlanAction[]
  targetRepo: string | null
  deployPages: boolean
  snapshot: AgentOperationSnapshot | null
}

export type PreparedAgentOperation = {
  plan: AgentOperationPlan
  planCanonical: string
  planHash: string
  operation: AgentOperationPayload
  operationHash: string
  taskId: string
  risk: {
    level: 'high'
    blocked: false
    needsConfirmation: true
    reason: string
    files: string[]
    operation: 'publish'
    title: string
  }
}

type TaskAuthority = {
  id: string
  repo: string | null
  branch: string
  agent_branch: string | null
  meta: Record<string, unknown> | null
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null
}

function normalizeRepoName(value: string): string {
  const name = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 90)
  if (!name || name === '.' || name === '..') throw new Error('仓库名称无效')
  return name
}

function normalizeInitialActions(actions: PlanAction[]): PlanAction[] {
  const creates = actions.filter(action => action.kind === 'create_repo')
  const pages = actions.filter(action => action.kind === 'enable_pages')
  if (creates.length !== 1) throw new Error('新项目必须且只能包含一个 create_repo 操作')
  if (pages.length > 1) throw new Error('enable_pages 不能重复')
  if (actions.length > 22) throw new Error('单次最多包含 20 个文件改动')

  const safety = assessInitialRepositoryPublication(actions.flatMap<PublicationFile>(action => {
    if (action.kind === 'write_file') return [{ path: action.path, content: action.newContent }]
    if (action.kind === 'delete_file') return [{ path: action.path, content: null }]
    return []
  }))
  if (!safety.ok) throw new Error(safety.reason)

  const seen = new Set<string>()
  let totalBytes = 0
  const normalized = actions.map(action => {
    if (action.kind === 'create_repo') return {
      ...action,
      name: normalizeRepoName(action.name),
      description: (action.description ?? '').slice(0, 350),
      private: action.private === true,
    }
    if (action.kind === 'write_file') {
      if (seen.has(action.path)) throw new Error(`文件操作重复：${action.path}`)
      seen.add(action.path)
      totalBytes += Buffer.byteLength(action.newContent, 'utf8')
      return action
    }
    if (action.kind === 'delete_file') {
      if (seen.has(action.path)) throw new Error(`文件操作重复：${action.path}`)
      seen.add(action.path)
    }
    return action
  })
  if (seen.size > 20) throw new Error('单次最多改动 20 个文件')
  if (totalBytes > 700_000) throw new Error('代码内容总量超过 700KB 的耐久作业上限')
  return normalized
}

function manifestFromArtifact(value: unknown, userId: string, taskId: string): SnapshotManifest | null {
  const row = record(value)
  if (!row || typeof row.content !== 'string') return null
  let parsed: unknown
  try { parsed = JSON.parse(row.content) } catch { return null }
  const envelope = record(parsed)
  if (envelope?.format !== 'cas-v1') return null
  const verified = parseAndVerifyManifest(envelope.manifest, { userId, taskId })
  if (!verified.ok) throw new Error(`CAS snapshot manifest 无效：${verified.error}`)
  return verified.manifest
}

async function latestAuthoritySnapshot(
  client: SupabaseClient,
  userId: string,
  taskId: string,
): Promise<SnapshotManifest> {
  const { data: head, error: headError } = await client.from('agent_workspace_heads')
    .select('snapshot_id,manifest_digest,tree_digest,head')
    .eq('task_id', taskId).eq('user_id', userId).maybeSingle()
  if (headError || !head) throw new Error('任务缺少 Worker 生成的 DB current-head，拒绝发布')
  const { data, error } = await client.from('agent_artifacts')
    .select('id,title,content,meta,created_at')
    .eq('task_id', taskId).eq('user_id', userId).eq('kind', 'summary')
    .eq('title', `snapshot:${head.snapshot_id}`).maybeSingle()
  if (error || !data) throw new Error('无法读取 DB 权威 CAS snapshot')
  const manifest = manifestFromArtifact(data, userId, taskId)
  if (!manifest || !manifest.reason.startsWith('authority:')
      || manifest.snapshotId !== head.snapshot_id
      || manifest.manifestDigest !== head.manifest_digest
      || manifest.treeDigest !== head.tree_digest
      || manifest.head !== head.head) {
    throw new Error('DB current-head 与不可变 CAS manifest 不一致，拒绝发布')
  }
  return manifest
}

async function taskAuthority(
  client: SupabaseClient,
  userId: string,
  taskId: string,
): Promise<TaskAuthority> {
  const { data, error } = await client.from('agent_tasks')
    .select('id,repo,branch,agent_branch,meta').eq('id', taskId).eq('user_id', userId).maybeSingle()
  if (error) throw new Error('任务权威状态暂时不可用')
  if (!data) throw new Error('任务不存在或无权访问')
  return {
    id: String(data.id),
    repo: typeof data.repo === 'string' ? data.repo : null,
    branch: typeof data.branch === 'string' ? data.branch : 'main',
    agent_branch: typeof data.agent_branch === 'string' ? data.agent_branch : null,
    meta: record(data.meta),
  }
}

function actionBindings(actions: PlanAction[]): CanonicalValue[] {
  return actions.map<CanonicalValue>(action => {
    if (action.kind === 'write_file') return {
      kind: action.kind, path: action.path,
      oldContentSha256: sha256(action.oldContent), newContentSha256: sha256(action.newContent),
      newContentBytes: Buffer.byteLength(action.newContent, 'utf8'),
    } as CanonicalValue
    if (action.kind === 'delete_file') return { kind: action.kind, path: action.path } as CanonicalValue
    if (action.kind === 'create_repo') return {
      kind: action.kind, name: action.name, descriptionSha256: sha256(action.description ?? ''),
      private: action.private === true,
    } as CanonicalValue
    return { kind: action.kind } as CanonicalValue
  })
}

/** Build the exact high-risk plan only from validated input and DB authority. */
export async function prepareAgentOperation(
  client: SupabaseClient,
  userId: string,
  input: CodeApplyRequest,
): Promise<PreparedAgentOperation> {
  if (!input.taskId) throw new Error('缺少耐久操作 taskId')
  const workspace = input.mode === 'workspace_pr'
  const task: TaskAuthority = workspace
    ? await taskAuthority(client, userId, input.taskId)
    : {
        id: input.taskId,
        repo: null,
        branch: 'main',
        agent_branch: null,
        meta: null,
      }
  if (workspace && input.actions.length) throw new Error('workspace 发布不接受浏览器提供的文件内容')
  if (!workspace && task.repo) throw new Error('已有仓库禁止 direct_push，必须通过 workspace Pull Request')

  const actions = workspace ? [] : normalizeInitialActions(input.actions)
  const snapshotManifest = workspace
    ? await latestAuthoritySnapshot(client, userId, task.id)
    : null
  if (workspace && (!task.repo || !task.agent_branch)) {
    throw new Error('任务缺少 DB 权威仓库或 Agent 分支绑定')
  }
  const snapshot = snapshotManifest ? {
    snapshotId: snapshotManifest.snapshotId,
    manifestDigest: snapshotManifest.manifestDigest,
    treeDigest: snapshotManifest.treeDigest,
    head: snapshotManifest.head,
  } : null
  const deployPages = workspace
    ? task.meta?.deployPages === true
    : actions.some(action => action.kind === 'enable_pages')
  const operation: AgentOperationPayload = {
    schemaVersion: 1,
    kind: workspace ? 'workspace_publish' : 'initial_repository',
    taskId: task.id,
    message: input.message.slice(0, 200),
    actions,
    targetRepo: workspace ? task.repo : null,
    deployPages,
    snapshot,
  }
  const operationHash = sha256JobValue(operation)
  const files = workspace
    ? snapshotManifest!.entries.map(entry => entry.path).sort()
    : actions.flatMap(action => action.kind === 'write_file' || action.kind === 'delete_file' ? [action.path] : [])
  const plan: AgentOperationPlan = {
    version: 1,
    userId,
    taskId: task.id,
    repo: task.repo,
    operation: 'publish',
    files,
    baseBranch: task.branch,
    workspaceBranch: workspace ? task.agent_branch : null,
    head: snapshot?.head ?? null,
    workspaceStateSha256: snapshot?.manifestDigest ?? operationHash,
    payload: {
      kind: operation.kind,
      operationInputSha256: operationHash,
      messageSha256: sha256(operation.message),
      deployPages,
      targetRepo: operation.targetRepo,
      snapshotId: snapshot?.snapshotId ?? null,
      snapshotManifestSha256: snapshot?.manifestDigest ?? null,
      actions: actionBindings(actions),
    },
  }
  const planCanonical = canonicalAgentOperationPlan(plan)
  return {
    plan,
    planCanonical,
    planHash: sha256(planCanonical),
    operation,
    operationHash,
    taskId: task.id,
    risk: {
      level: 'high', blocked: false, needsConfirmation: true, operation: 'publish', files,
      title: workspace ? '提交、推送并发布 Pull Request' : '创建并发布 GitHub 仓库',
      reason: '该操作会产生 GitHub 外部副作用；确认仅绑定当前精确计划、10 分钟有效且只能消费一次。',
    },
  }
}
