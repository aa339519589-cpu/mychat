import { resolveAuth } from '@/lib/api/guard'
import { createRepo, commitFiles, enablePages, type FileWrite } from '@/lib/github'
import type { PlanAction } from '@/lib/code-data'
import { applyOutcome, type CodeApplyOutcome } from './apply-contract'
import type { CodeApplyRequest } from './apply-request'
import { publishWorkspaceRequest } from './workspace-publish'

async function publishInitialRepository(
  input: CodeApplyRequest,
  token: string,
): Promise<CodeApplyOutcome> {
  const { actions, message } = input
  if (actions.length === 0) return applyOutcome({ error: '没有要执行的改动' }, 400)

  const createAction = actions.find(action => action.kind === 'create_repo') as Extract<PlanAction, { kind: 'create_repo' }> | undefined
  if (!createAction) {
    return applyOutcome({ error: '已有仓库必须通过 workspace 创建 Pull Request' }, 400)
  }

  const writes = actions.filter(action => action.kind === 'write_file') as Extract<PlanAction, { kind: 'write_file' }>[]
  const deletes = actions.filter(action => action.kind === 'delete_file') as Extract<PlanAction, { kind: 'delete_file' }>[]
  if (writes.length + deletes.length > 20) return applyOutcome({ error: '单次最多改动 20 个文件' }, 400)
  const totalSize = writes.reduce((sum, write) => sum + write.newContent.length, 0)
  if (totalSize > 1_000_000) return applyOutcome({ error: '内容总量超过 1MB 限制' }, 400)

  const created = await createRepo(token, createAction.name, createAction.description ?? '', !!createAction.private)
  if ('error' in created) return applyOutcome({ error: created.error }, 502)

  const result: Record<string, unknown> = {
    repoUrl: created.htmlUrl,
    repo: created.fullName,
    created: true,
  }
  if (writes.length || deletes.length) {
    const files: FileWrite[] = [
      ...writes.map(write => ({ path: write.path, content: write.newContent })),
      ...deletes.map(remove => ({ path: remove.path, content: null })),
    ]
    const commit = await commitFiles(
      token,
      created.fullName,
      created.defaultBranch,
      files,
      message || 'Claude 代码改动',
    )
    if ('error' in commit) return applyOutcome({ error: commit.error }, 502)
    result.commitSha = commit.commitSha
  }

  if (actions.some(action => action.kind === 'enable_pages')) {
    const pages = await enablePages(token, created.fullName, created.defaultBranch, {
      verifyUrl: !createAction.private,
      expectedCommitSha: result.commitSha as string | undefined,
    })
    result.pagesUrl = pages.url
    result.pagesStatus = pages.status
    if (pages.status === 'failed') result.pagesError = pages.error
  }

  return applyOutcome({ ...result, mode: 'direct_push' })
}

/** Application service for Code publish/apply operations. */
export async function applyCodeChanges(
  input: CodeApplyRequest,
  token: string,
): Promise<CodeApplyOutcome> {
  if (input.mode === 'workspace_pr' || input.taskId) {
    if (!input.taskId) return applyOutcome({ error: 'mode=workspace_pr 但缺少 taskId' }, 400)
    const auth = await resolveAuth()
    if (!auth.supabase || !auth.userId) return applyOutcome({ error: '未登录' }, 401)
    return publishWorkspaceRequest(input, input.taskId, token, auth.supabase, auth.userId)
  }
  return publishInitialRepository(input, token)
}
