import assert from 'node:assert/strict'
import test from 'node:test'
import type { SupabaseClient } from '@supabase/supabase-js'
import { sha256 } from '../lib/agent/confirmation-plan'
import {
  computeManifestDigest,
  computeTreeDigest,
  sha256 as snapshotSha256,
} from '../lib/agent/snapshot/cas-integrity'
import type { SnapshotManifest } from '../lib/agent/snapshot/cas-types'
import type { PlanAction } from '../lib/code-data'
import type { CodeApplyRequest } from '../lib/code-agent/apply-request'
import { requestOrEnqueueAgentOperation } from '../lib/code-agent/operation-enqueue'
import {
  prepareAgentOperation,
  type PreparedAgentOperation,
} from '../lib/code-agent/operation-plan'

const userId = '86000000-0000-4000-8000-000000000001'
const taskId = '86000000-0000-4000-8000-000000000002'
const confirmationId = '86000000-0000-4000-8000-000000000003'
const jobId = '86000000-0000-4000-8000-000000000004'

function initialRequest(
  actions: PlanAction[],
  overrides: Partial<CodeApplyRequest> = {},
): CodeApplyRequest {
  return {
    repo: null,
    taskId,
    mode: 'direct_push',
    message: 'publish the project',
    actions,
    ...overrides,
  }
}

function initialActions(): PlanAction[] {
  return [
    {
      kind: 'create_repo',
      name: ' Fancy Project ',
      description: 'A deterministic project',
      private: true,
    },
    {
      kind: 'write_file',
      path: 'src/app.ts',
      oldContent: '',
      newContent: 'export const value = 1\n',
    },
    { kind: 'delete_file', path: 'legacy.txt' },
    { kind: 'enable_pages' },
  ]
}

function unusedClient(): SupabaseClient {
  return {} as SupabaseClient
}

type DatabaseResult = { data: unknown; error: unknown }

function authorityClient(results: Record<string, DatabaseResult>): SupabaseClient {
  return {
    from(table: string) {
      const query = {
        select() { return query },
        eq() { return query },
        maybeSingle() {
          return Promise.resolve(results[table] ?? { data: null, error: null })
        },
      }
      return query
    },
  } as unknown as SupabaseClient
}

function rpcClient(
  handler: (name: string, args: Record<string, unknown>) => DatabaseResult | Promise<DatabaseResult>,
): SupabaseClient {
  return {
    rpc: (name: string, args: Record<string, unknown>) => Promise.resolve(handler(name, args)),
  } as unknown as SupabaseClient
}

function authorityManifest(): SnapshotManifest {
  const content = Buffer.from('export const value = 2\n')
  const entries: SnapshotManifest['entries'] = [{
    path: 'src/app.ts',
    kind: 'file',
    change: 'modified',
    mode: 0o644,
    size: content.byteLength,
    digest: snapshotSha256(content),
  }, {
    path: 'src/new.ts',
    kind: 'file',
    change: 'created',
    mode: 0o644,
    size: 4,
    digest: snapshotSha256('new\n'),
  }]
  const unsigned: Omit<SnapshotManifest, 'manifestDigest'> = {
    schemaVersion: 1,
    scope: 'git-working-tree',
    snapshotId: 'snapshot-authority-1',
    taskId,
    userId,
    reason: 'authority:after-tool',
    createdAt: '2026-07-15T00:00:00.000Z',
    head: 'a'.repeat(40),
    parentSnapshotId: null,
    parentDigest: null,
    entries,
    treeDigest: computeTreeDigest(entries),
  }
  return { ...unsigned, manifestDigest: computeManifestDigest(unsigned) }
}

function workspaceClient(
  manifest = authorityManifest(),
  task: Record<string, unknown> = {
    id: taskId,
    repo: 'owner/project',
    branch: 'main',
    agent_branch: 'agent/task-86000000',
    meta: { deployPages: true },
  },
): SupabaseClient {
  return authorityClient({
    agent_tasks: { data: task, error: null },
    agent_workspace_heads: {
      data: {
        snapshot_id: manifest.snapshotId,
        manifest_digest: manifest.manifestDigest,
        tree_digest: manifest.treeDigest,
        head: manifest.head,
      },
      error: null,
    },
    agent_artifacts: {
      data: { content: JSON.stringify({ format: 'cas-v1', manifest }) },
      error: null,
    },
  })
}

test('initial repository plans normalize actions and bind content by digest', async () => {
  const request = initialRequest(initialActions(), { message: 'm'.repeat(250) })
  const first = await prepareAgentOperation(unusedClient(), userId, request)
  const second = await prepareAgentOperation(unusedClient(), userId, request)

  assert.equal(first.operation.kind, 'initial_repository')
  assert.equal(first.operation.message.length, 200)
  assert.deepEqual(first.operation.actions[0], {
    kind: 'create_repo',
    name: 'fancy-project',
    description: 'A deterministic project',
    private: true,
  })
  assert.equal(first.operation.targetRepo, null)
  assert.equal(first.operation.deployPages, true)
  assert.equal(first.operation.snapshot, null)
  assert.deepEqual(first.plan.files, ['src/app.ts', 'legacy.txt'])
  assert.equal(first.plan.repo, null)
  assert.equal(first.plan.workspaceBranch, null)
  assert.equal(first.plan.head, null)
  assert.match(first.operationHash, /^[0-9a-f]{64}$/)
  assert.match(first.planHash, /^[0-9a-f]{64}$/)
  assert.equal(first.operationHash, second.operationHash)
  assert.equal(first.planHash, second.planHash)
  assert.equal(first.planCanonical.includes('export const value = 1'), false)
  assert.match(first.planCanonical, /newContentSha256/)
  assert.deepEqual(first.risk.files, ['src/app.ts', 'legacy.txt'])
  assert.equal(first.risk.needsConfirmation, true)
})

test('initial repository planning rejects ambiguous, oversized, and sensitive actions', async () => {
  await assert.rejects(
    prepareAgentOperation(unusedClient(), userId, initialRequest(initialActions(), { taskId: undefined })),
    /缺少耐久操作 taskId/,
  )
  await assert.rejects(
    prepareAgentOperation(unusedClient(), userId, initialRequest([])),
    /只能包含一个 create_repo/,
  )
  await assert.rejects(
    prepareAgentOperation(unusedClient(), userId, initialRequest([
      ...initialActions(),
      { kind: 'create_repo', name: 'second' },
    ])),
    /只能包含一个 create_repo/,
  )
  await assert.rejects(
    prepareAgentOperation(unusedClient(), userId, initialRequest([
      ...initialActions(),
      { kind: 'enable_pages' },
    ])),
    /enable_pages 不能重复/,
  )
  await assert.rejects(
    prepareAgentOperation(unusedClient(), userId, initialRequest([
      { kind: 'create_repo', name: '.' },
    ])),
    /仓库名称无效/,
  )
  await assert.rejects(
    prepareAgentOperation(unusedClient(), userId, initialRequest([
      { kind: 'create_repo', name: 'safe' },
      { kind: 'write_file', path: '.env', oldContent: '', newContent: 'SAFE=value' },
    ])),
    /关键安全文件/,
  )
  await assert.rejects(
    prepareAgentOperation(unusedClient(), userId, initialRequest([
      { kind: 'create_repo', name: 'safe' },
      { kind: 'write_file', path: 'same.ts', oldContent: '', newContent: 'one' },
      { kind: 'delete_file', path: 'same.ts' },
    ])),
    /文件操作重复/,
  )
  await assert.rejects(
    prepareAgentOperation(unusedClient(), userId, initialRequest([
      { kind: 'create_repo', name: 'safe' },
      ...Array.from({ length: 22 }, (_, index): PlanAction => ({
        kind: 'write_file', path: `src/${index}.ts`, oldContent: '', newContent: 'x',
      })),
    ])),
    /单次最多包含 20 个文件改动/,
  )
  await assert.rejects(
    prepareAgentOperation(unusedClient(), userId, initialRequest([
      { kind: 'create_repo', name: 'safe' },
      ...Array.from({ length: 21 }, (_, index): PlanAction => ({
        kind: 'write_file', path: `src/${index}.ts`, oldContent: '', newContent: 'x',
      })),
    ])),
    /单次最多改动 20 个文件/,
  )
  await assert.rejects(
    prepareAgentOperation(unusedClient(), userId, initialRequest([
      { kind: 'create_repo', name: 'safe' },
      { kind: 'write_file', path: 'large.txt', oldContent: '', newContent: 'x'.repeat(700_001) },
    ])),
    /代码内容总量超过 700KB/,
  )
})

test('workspace publication accepts only a matching immutable CAS authority', async () => {
  const manifest = authorityManifest()
  const prepared = await prepareAgentOperation(workspaceClient(manifest), userId, {
    repo: 'untrusted/ignored',
    taskId,
    mode: 'workspace_pr',
    message: 'publish workspace',
    actions: [],
  })

  assert.equal(prepared.operation.kind, 'workspace_publish')
  assert.equal(prepared.operation.targetRepo, 'owner/project')
  assert.deepEqual(prepared.operation.actions, [])
  assert.equal(prepared.operation.deployPages, true)
  assert.deepEqual(prepared.operation.snapshot, {
    snapshotId: manifest.snapshotId,
    manifestDigest: manifest.manifestDigest,
    treeDigest: manifest.treeDigest,
    head: manifest.head,
  })
  assert.deepEqual(prepared.plan.files, ['src/app.ts', 'src/new.ts'])
  assert.equal(prepared.plan.workspaceBranch, 'agent/task-86000000')
  assert.equal(prepared.plan.workspaceStateSha256, manifest.manifestDigest)
  assert.equal(prepared.plan.payload.snapshotManifestSha256, manifest.manifestDigest)
})

test('workspace planning fails closed on every missing or inconsistent authority', async () => {
  const request = initialRequest([], { mode: 'workspace_pr' })
  await assert.rejects(
    prepareAgentOperation(authorityClient({
      agent_tasks: { data: null, error: { code: 'offline' } },
    }), userId, request),
    /权威状态暂时不可用/,
  )
  await assert.rejects(
    prepareAgentOperation(authorityClient({
      agent_tasks: { data: null, error: null },
    }), userId, request),
    /任务不存在或无权访问/,
  )
  await assert.rejects(
    prepareAgentOperation(workspaceClient(), userId, {
      ...request,
      actions: [{ kind: 'enable_pages' }],
    }),
    /不接受浏览器提供的文件内容/,
  )

  const task = {
    id: taskId,
    repo: 'owner/project',
    branch: 'main',
    agent_branch: 'agent/task',
    meta: null,
  }
  await assert.rejects(
    prepareAgentOperation(authorityClient({
      agent_tasks: { data: task, error: null },
      agent_workspace_heads: { data: null, error: null },
    }), userId, request),
    /缺少 Worker 生成的 DB current-head/,
  )

  const manifest = authorityManifest()
  await assert.rejects(
    prepareAgentOperation(authorityClient({
      agent_tasks: { data: task, error: null },
      agent_workspace_heads: {
        data: {
          snapshot_id: manifest.snapshotId,
          manifest_digest: manifest.manifestDigest,
          tree_digest: manifest.treeDigest,
          head: manifest.head,
        },
        error: null,
      },
      agent_artifacts: { data: null, error: null },
    }), userId, request),
    /无法读取 DB 权威 CAS snapshot/,
  )
  await assert.rejects(
    prepareAgentOperation(workspaceClient({ ...manifest, reason: 'manual' }), userId, request),
    /CAS snapshot manifest 无效|current-head 与不可变 CAS manifest 不一致/,
  )
  await assert.rejects(
    prepareAgentOperation(workspaceClient(manifest, {
      ...task,
      repo: null,
      agent_branch: null,
    }), userId, request),
    /缺少 DB 权威仓库或 Agent 分支绑定/,
  )
})

async function preparedInitial(): Promise<PreparedAgentOperation> {
  return prepareAgentOperation(unusedClient(), userId, initialRequest(initialActions()))
}

test('initial publication creates an opaque one-use confirmation gate', async () => {
  const prepared = await preparedInitial()
  let rpcArgs: Record<string, unknown> = {}
  const client = rpcClient((name, args) => {
    assert.equal(name, 'create_agent_operation_confirmation')
    rpcArgs = args
    return {
      data: [{
        ok: true,
        id: confirmationId,
        expiresAt: '2026-07-15T00:10:00.000Z',
      }],
      error: null,
    }
  })
  const response = await requestOrEnqueueAgentOperation({
    client,
    commandClient: unusedClient(),
    userId,
    authClass: 'registered',
    prepared,
  })

  assert.equal(response.status, 409)
  assert.equal(response.body.needsConfirmation, true)
  assert.equal(response.body.confirmationId, confirmationId)
  assert.match(String(response.body.confirmationToken), /^[A-Za-z0-9_-]{43}$/)
  assert.match(String(rpcArgs.input_token_sha256), /^[0-9a-f]{64}$/)
  assert.equal(rpcArgs.input_goal, '创建并发布 fancy-project')
  assert.equal(rpcArgs.input_plan_canonical, prepared.planCanonical)
  assert.equal(JSON.stringify(rpcArgs).includes(String(response.body.confirmationToken)), false)

  await assert.rejects(
    requestOrEnqueueAgentOperation({
      client: rpcClient(() => ({ data: { ok: false }, error: null })),
      commandClient: unusedClient(),
      userId,
      authClass: 'registered',
      prepared,
    }),
    /无法原子创建发布任务与确认门/,
  )
})

test('confirmed publication atomically enqueues, replays, and maps fenced rejection reasons', async () => {
  const initial = await preparedInitial()
  const confirmation = { confirmationId, confirmationToken: 'A'.repeat(43) }
  let enqueueArgs: Record<string, unknown> = {}
  const success = await requestOrEnqueueAgentOperation({
    client: unusedClient(),
    commandClient: rpcClient((name, args) => {
      assert.equal(name, 'enqueue_agent_operation')
      enqueueArgs = args
      return {
        data: [{ enqueued: true, replayed: false, job: { id: jobId, status: 'queued' } }],
        error: null,
      }
    }),
    userId,
    authClass: 'registered',
    prepared: initial,
    confirmation,
  })
  assert.deepEqual(success, {
    status: 202,
    body: {
      schemaVersion: 1,
      jobId,
      taskId,
      status: 'queued',
      created: true,
      streamUrl: `/api/v1/jobs/${jobId}/events?from_seq=0`,
    },
    headers: {
      'Cache-Control': 'no-store',
      Location: `/api/v1/jobs/${jobId}`,
    },
  })
  assert.equal(enqueueArgs.input_confirmation_id, confirmationId)
  assert.equal(enqueueArgs.input_token_sha256, sha256(confirmation.confirmationToken))
  assert.equal(enqueueArgs.input_idempotency_key, `agent-operation:${confirmationId}`)
  assert.match(String(enqueueArgs.input_job_id), /^[0-9a-f-]{36}$/)
  assert.equal(enqueueArgs.input_snapshot_id, null)
  assert.equal(enqueueArgs.input_snapshot_digest, null)
  assert.equal(JSON.stringify(enqueueArgs).includes(confirmation.confirmationToken), false)

  const workspace = await prepareAgentOperation(workspaceClient(), userId, {
    repo: null, taskId, mode: 'workspace_pr', message: '', actions: [],
  })
  let replayArgs: Record<string, unknown> = {}
  const replay = await requestOrEnqueueAgentOperation({
    client: unusedClient(),
    commandClient: rpcClient((_name, args) => {
      replayArgs = args
      return {
        data: { enqueued: false, replayed: true, job: { id: jobId, status: 'queued' } },
        error: null,
      }
    }),
    userId,
    authClass: 'anonymous',
    prepared: workspace,
    confirmation,
  })
  assert.equal(replay.body.created, false)
  assert.equal(replayArgs.input_auth_class, 'anonymous')
  assert.equal(replayArgs.input_snapshot_id, workspace.operation.snapshot?.snapshotId)
  assert.equal(replayArgs.input_snapshot_digest, workspace.operation.snapshot?.manifestDigest)

  const reasons = new Map<unknown, [number, RegExp]>([
    ['expired', [409, /确认已过期/]],
    ['plan_mismatch', [409, /计划已变化/]],
    ['not_approved', [409, /尚未获得用户确认/]],
    ['already_consumed', [409, /其他操作消费/]],
    ['invalid_confirmation', [403, /确认凭据无效/]],
    ['unknown', [409, /确认状态已变化/]],
  ])
  for (const [reason, [status, message]] of reasons) {
    const rejected = await requestOrEnqueueAgentOperation({
      client: unusedClient(),
      commandClient: rpcClient(() => ({ data: { reason }, error: null })),
      userId,
      authClass: 'registered',
      prepared: initial,
      confirmation,
    })
    assert.equal(rejected.status, status)
    assert.match(String(rejected.body.error), message)
  }

  await assert.rejects(
    requestOrEnqueueAgentOperation({
      client: unusedClient(),
      commandClient: rpcClient(() => ({ data: null, error: { code: 'offline' } })),
      userId,
      authClass: 'registered',
      prepared: initial,
      confirmation,
    }),
    /发布作业原子入队失败/,
  )
  await assert.rejects(
    requestOrEnqueueAgentOperation({
      client: unusedClient(),
      commandClient: rpcClient(() => ({
        data: { enqueued: true, replayed: false, job: { id: 42, status: null } },
        error: null,
      })),
      userId,
      authClass: 'registered',
      prepared: initial,
      confirmation,
    }),
    /发布作业入队结果无效/,
  )
})
