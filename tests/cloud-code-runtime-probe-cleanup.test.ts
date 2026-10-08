import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { cleanupAcceptanceAccount, provisionAcceptanceQuota, safeAcceptanceApiFailure } from '../scripts/cleanup-cloud-code-acceptance.mjs'

const principal = '29b06273-8b6e-424a-9021-c6f3169cb22e'
const jobId = 'fa56ac8d-562b-4085-85c8-f747d6aa4a39'
const connectorId = 'd71588e3-17f3-4710-bada-29d51a34e263'
const email = 'cloud-code-probe-00000000-0000-4000-8000-000000000001@example.com'
type Call = { path: string; method: string; body: unknown; admin: boolean }

test('only a verified disposable principal gets a bounded concurrency quota without crediting balance', async () => {
  const calls: Call[] = []
  const database = async (path: string, method = 'GET', body?: unknown, admin = false) => {
    calls.push({ path, method, body, admin })
    if (path.startsWith('/auth/')) return { id: principal, email }
    if (method === 'GET') return [{ user_id: principal }]
    return [{ user_id: principal, limit_5h: 2_000_000 }]
  }
  const result = await provisionAcceptanceQuota(database, principal)
  assert.equal(result.limit5h, 2_000_000)
  const mutation = calls.find(call => call.method === 'PATCH')!
  assert.equal(mutation.path, `/rest/v1/profiles?user_id=eq.${principal}`)
  assert.deepEqual(mutation.body, { limit_5h: 2_000_000 })
  assert.equal(result.balanceModified, false)
  assert.equal(result.weeklyLimitModified, false)
  await assert.rejects(() => provisionAcceptanceQuota(async () => ({ id: principal, email: 'real-user@example.com' }), principal))
})

test('new disposable profile initialization sets only identity and bounded test quota', async () => {
  let inserted: unknown
  const result = await provisionAcceptanceQuota(async (path: string, method = 'GET', body?: unknown) => {
    if (path.startsWith('/auth/')) return { id: principal, email }
    if (method === 'GET') return []
    inserted = body
    return [{ user_id: principal, limit_5h: 2_000_000 }]
  }, principal)
  assert.deepEqual(inserted, { user_id: principal, limit_5h: 2_000_000 })
  assert.equal(result.isolatedTestAccount, true)
})

test('cleanup waits for terminal cancellation and released reservations, preserves all audit rows', async () => {
  const calls: Call[] = []
  let cancelled = false
  let banned = false
  let deleted = false
  const database = async (path: string, method = 'GET', body?: unknown, admin = false) => {
    calls.push({ path, method, body, admin })
    if (path.startsWith('/auth/') && method === 'GET') return { id: principal, email,
      banned_until: banned ? '2126-01-01T00:00:00Z' : null, deleted_at: deleted ? '2026-10-08T00:00:00Z' : null }
    if (path.startsWith('/auth/') && method === 'PUT') { banned = true; return true }
    if (path.startsWith('/auth/') && method === 'DELETE') { deleted = true; return true }
    if (path.startsWith('/rest/v1/jobs?')) return [{ id: jobId, status: cancelled ? 'cancelled' : 'running' }]
    if (path === '/rest/v1/rpc/cancel_job') { cancelled = true; return { accepted: true } }
    if (path.startsWith('/rest/v1/job_admission_reservations?')) return []
    if (path.startsWith('/rest/v1/mcp_connectors?') && method === 'GET') return [{ id: connectorId, server_url: 'https://developers.openai.com/mcp' }]
    return true
  }
  const result = await cleanupAcceptanceAccount({ database, principalId: principal, run: '37786907076', wait: async () => {}, verifyOldSession: async () => true })
  assert.equal(result.accountDisabled, true)
  assert.equal(result.retainedAuditRows, true)
  assert.equal(result.sessionsRevoked, true)
  assert.equal(result.authSoftDeleted, true)
  assert.deepEqual(result.auditJobs, [jobId])
  const deletion = calls.filter(call => call.method === 'DELETE')
  assert.equal(deletion.length, 1)
  assert.equal(deletion[0].path, `/auth/v1/admin/users/${principal}`)
  assert.deepEqual(deletion[0].body, { should_soft_delete: true })
  assert.ok(!calls.some(call => /\/rest\/v1\/(?:jobs|ledger_entries|job_admission_reservations)/.test(call.path) && call.method !== 'GET'))
  assert.ok(calls.filter(call => call.path.startsWith('/rest/v1/') && call.method === 'GET').every(call => call.path.includes(principal)))
  const revoke = calls.find(call => call.path === '/rest/v1/rpc/delete_github_connection')!
  assert.deepEqual(revoke.body, { input_user_id: principal, input_connection_id: null,
    input_actor_id: principal, input_request_id: 'cloud-acceptance-cleanup-37786907076' })
})

test('cleanup still revokes and disables identity while settlement is pending, retaining audit rows', async () => {
  const mutations: string[] = []
  let banned = false
  const result = await cleanupAcceptanceAccount({ principalId: principal, run: '37786907076', wait: async () => {},
    database: async (path: string, method = 'GET') => {
      if (method !== 'GET') mutations.push(path)
      if (path.startsWith('/auth/') && method === 'PUT') { banned = true; return true }
      if (path.startsWith('/auth/')) return { id: principal, email, banned_until: banned ? '2126-01-01T00:00:00Z' : null }
      if (path.startsWith('/rest/v1/mcp_connectors?')) return []
      if (path === '/rest/v1/rpc/delete_github_connection') return true
      return [{ id: jobId, status: 'failed', job_id: jobId }]
    },
  })
  assert.equal(result.ok, false)
  assert.equal(result.accountDisabled, true)
  assert.equal(result.githubConnectionRevoked, true)
  assert.equal(result.reservationsReleased, false)
  assert.ok(result.errors.includes('settlement_pending_account_disabled'))
  assert.ok(mutations.includes('/rest/v1/rpc/delete_github_connection'))
  assert.ok(mutations.includes(`/auth/v1/admin/users/${principal}`))
  assert.equal(result.authSoftDeleted, false)
})

test('HTTP success without disabled readback or rejected old session cannot claim successful cleanup', async () => {
  const result = await cleanupAcceptanceAccount({ principalId: principal, run: '37786907076', wait: async () => {},
    verifyOldSession: async () => false,
    database: async (path: string, method = 'GET') => {
      if (path.startsWith('/auth/') && method === 'GET') return { id: principal, email }
      if (path.startsWith('/rest/v1/jobs?')) return [{ id: jobId, status: 'failed' }]
      if (path.startsWith('/rest/v1/job_admission_reservations?') || path.startsWith('/rest/v1/mcp_connectors?')) return []
      return true
    },
  })
  assert.equal(result.ok, false)
  assert.equal(result.accountDisabled, false)
  assert.equal(result.sessionsRevoked, false)
  assert.ok(result.errors.includes('old_session_still_valid'))
})

test('API diagnostics retain safe envelope code/request id/category without reflecting arbitrary message secrets', () => {
  const secret = crypto.randomUUID()
  const diagnostics = safeAcceptanceApiFailure(new Response(null, { status: 503 }), {
    error: { code: 'DEPENDENCY_UNAVAILABLE', message: `Agent 作业暂时无法入队 ${secret}` }, request_id: jobId,
  }, '/api/code/chat')
  assert.equal(diagnostics.code, 'DEPENDENCY_UNAVAILABLE')
  assert.equal(diagnostics.requestId, jobId)
  assert.equal(diagnostics.messageCategory, 'atomic_admission')
  assert.ok(!JSON.stringify(diagnostics).includes(secret))
})

test('probe reports every admitted job and standalone cleanup is pinned to the known acceptance authority', () => {
  const probe = readFileSync(new URL('../scripts/probe-cloud-code-workspace.mjs', import.meta.url), 'utf8')
  const cleanup = readFileSync(new URL('../scripts/cleanup-cloud-code-acceptance.mjs', import.meta.url), 'utf8')
  assert.match(probe, /report\.admittedJobs = tasks\.map/)
  assert.match(cleanup, /jobs\[0\]\.principal_id !== KNOWN_PRINCIPAL/)
  assert.ok(cleanup.includes(jobId) && cleanup.includes(principal))
})
