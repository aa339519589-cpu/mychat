import { pathToFileURL } from 'node:url'

const KNOWN_JOB = 'fa56ac8d-562b-4085-85c8-f747d6aa4a39'
const KNOWN_PRINCIPAL = '29b06273-8b6e-424a-9021-c6f3169cb22e'
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
const EMAIL = /^cloud-code-probe-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}@example\.com$/i
const TERMINAL = new Set(['completed', 'failed', 'cancelled'])
const PUBLIC_MCP = new Set(['https://developers.openai.com/mcp', 'https://mcp.context7.com/mcp'])

export async function verifiedDisposable(database, principalId) {
  if (!UUID.test(principalId ?? '')) throw new Error('Disposable identity invalid')
  const user = await database(`/auth/v1/admin/users/${principalId}`, 'GET', undefined, true)
  if (user?.id !== principalId || !EMAIL.test(user.email ?? '')) throw new Error('Disposable identity mismatch')
  return user
}

export async function provisionAcceptanceQuota(database, principalId) {
  await verifiedDisposable(database, principalId)
  const path = `/rest/v1/profiles?user_id=eq.${principalId}`
  const existing = await database(`${path}&select=user_id&limit=1`, 'GET', undefined, true)
  const rows = existing.length
    ? await database(path, 'PATCH', { limit_5h: 2_000_000 }, true)
    : await database('/rest/v1/profiles', 'POST', { user_id: principalId, limit_5h: 2_000_000 }, true)
  if (rows?.length !== 1 || rows[0].user_id !== principalId || rows[0].limit_5h !== 2_000_000) {
    throw new Error('Acceptance quota update was not scoped and verified')
  }
  return { principalId, isolatedTestAccount: true, limit5h: 2_000_000,
    balanceModified: false, weeklyLimitModified: false }
}

export function safeAcceptanceApiFailure(response, failure, path) {
  const envelope = failure?.error && typeof failure.error === 'object' ? failure.error : failure
  const message = typeof envelope?.message === 'string' ? envelope.message
    : typeof failure?.error === 'string' ? failure.error : ''
  const requestId = response.headers.get('x-request-id') ?? failure?.request_id
  return { path, httpStatus: response.status,
    code: typeof envelope?.code === 'string' && /^[A-Z0-9_]{1,100}$/.test(envelope.code) ? envelope.code : null,
    requestId: typeof requestId === 'string' && /^[A-Za-z0-9-]{1,100}$/.test(requestId) ? requestId : null,
    messageCategory: message.includes('额度') ? 'quota' : message.includes('入队') ? 'atomic_admission' : 'api_failure_redacted' }
}

/** Preserves jobs, reservations and ledger audit. Supabase Auth soft-delete
 * retains auth.users identity while invalidating authentication sessions.
 * @param {{ database: Function, principalId: string, run: string,
 * verifyOldSession?: (() => Promise<boolean>) | null, wait?: (ms: number) => Promise<void> }} options
 */
export async function cleanupAcceptanceAccount({ database, principalId, run, verifyOldSession = null,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  await verifiedDisposable(database, principalId)
  const result = { principalId, ok: false, accountDisabled: false, authSoftDeleted: false,
    sessionsRevoked: /** @type {boolean | null} */ (null), githubConnectionRevoked: false, publicMcpDisabled: 0,
    jobsTerminal: false, reservationsReleased: false, retainedAuditRows: true,
    auditJobs: /** @type {string[]} */ ([]), errors: /** @type {string[]} */ ([]) }
  const attempt = async (label, action) => {
    try { return await action() } catch { result.errors.push(label); return null }
  }
  const jobsPath = `/rest/v1/jobs?select=id,status&principal_id=eq.${principalId}&limit=100`
  let jobs = await attempt('jobs_read_failed', () => database(jobsPath, 'GET', undefined, true)) ?? []
  if (jobs.length >= 100) { result.errors.push('jobs_scope_exceeds_limit'); jobs = [] }
  result.auditJobs = jobs.map(job => job.id)
  for (const job of jobs) {
    if (!UUID.test(job.id)) { result.errors.push('job_identity_invalid'); continue }
    if (!TERMINAL.has(job.status)) await attempt('job_cancel_failed', () => database('/rest/v1/rpc/cancel_job', 'POST', {
      input_job_id: job.id, input_principal_id: principalId, input_reason: `Acceptance cleanup ${run}`,
    }, true))
  }
  const revoke = await attempt('github_revoke_failed', () => database('/rest/v1/rpc/delete_github_connection', 'POST', {
    input_user_id: principalId, input_connection_id: null, input_actor_id: principalId,
    input_request_id: `cloud-acceptance-cleanup-${run}`,
  }, true))
  result.githubConnectionRevoked = typeof revoke === 'boolean'
  const connectors = await attempt('mcp_read_failed', () => database(`/rest/v1/mcp_connectors?select=id,server_url&user_id=eq.${principalId}&limit=10`, 'GET', undefined, true)) ?? []
  if (connectors.length > 2) result.errors.push('mcp_scope_exceeds_limit')
  else for (const connector of connectors) {
    if (!UUID.test(connector.id) || !PUBLIC_MCP.has(connector.server_url)) { result.errors.push('mcp_scope_invalid'); continue }
    const disabled = await attempt('mcp_disable_failed', () => database(`/rest/v1/mcp_connectors?id=eq.${connector.id}&user_id=eq.${principalId}`, 'PATCH', { enabled: false }, true))
    if (disabled !== null) result.publicMcpDisabled++
  }
  await attempt('account_ban_failed', () => database(`/auth/v1/admin/users/${principalId}`, 'PUT', { ban_duration: '876000h' }, true))
  const banned = await attempt('account_ban_verify_failed', () => database(`/auth/v1/admin/users/${principalId}`, 'GET', undefined, true))
  result.accountDisabled = Date.parse(banned?.banned_until ?? '') > Date.now()
  if (!result.accountDisabled) result.errors.push('account_ban_not_verified')
  for (let index = 0; index < 18; index++) {
    const current = await attempt('terminal_read_failed', () => database(jobsPath, 'GET', undefined, true))
    const held = await attempt('reservation_read_failed', () => database(`/rest/v1/job_admission_reservations?select=job_id&principal_id=eq.${principalId}&status=eq.held&limit=100`, 'GET', undefined, true))
    result.jobsTerminal = Array.isArray(current) && current.every(job => TERMINAL.has(job.status))
    result.reservationsReleased = Array.isArray(held) && held.length === 0
    if (result.jobsTerminal && result.reservationsReleased) break
    await wait(10_000)
  }
  if (!result.jobsTerminal || !result.reservationsReleased) result.errors.push('settlement_pending_account_disabled')
  else {
    await attempt('auth_soft_delete_failed', () => database(`/auth/v1/admin/users/${principalId}`, 'DELETE', { should_soft_delete: true }, true))
    const after = await attempt('auth_disabled_verify_failed', () => database(`/auth/v1/admin/users/${principalId}`, 'GET', undefined, true))
    result.authSoftDeleted = typeof after?.deleted_at === 'string'
    result.accountDisabled = result.authSoftDeleted || Date.parse(after?.banned_until ?? '') > Date.now()
    if (!result.accountDisabled) result.errors.push('account_disabled_not_verified')
  }
  if (verifyOldSession) result.sessionsRevoked = await attempt('session_revocation_verify_failed', verifyOldSession)
  if (result.sessionsRevoked === false) result.errors.push('old_session_still_valid')
  result.ok = result.accountDisabled && result.jobsTerminal && result.reservationsReleased && result.errors.length === 0
  return result
}

async function standalone() {
  if (process.env.PRODUCTION_URL !== 'https://mychat-nm6x.onrender.com'
    || process.env.CODE_PROBE_CLEANUP_CONFIRM !== 'true'
    || !/^srv-[a-z0-9]+$/.test(process.env.RENDER_SERVICE_ID ?? '') || !process.env.RENDER_API_KEY) {
    throw new Error('Explicit bounded cleanup configuration required')
  }
  async function env(name) {
    const response = await fetch(`https://api.render.com/v1/services/${process.env.RENDER_SERVICE_ID}/env-vars/${name}`, {
      headers: { Authorization: `Bearer ${process.env.RENDER_API_KEY}` }, signal: AbortSignal.timeout(30_000), redirect: 'error',
    })
    if (!response.ok) throw new Error('Cleanup configuration unavailable')
    const value = await response.json()
    if (typeof value.value !== 'string' || !value.value) throw new Error('Cleanup configuration unavailable')
    return value.value
  }
  const [url, serviceRole] = await Promise.all([env('NEXT_PUBLIC_SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY')])
  const origin = new URL(url)
  if (origin.protocol !== 'https:' || !origin.hostname.endsWith('.supabase.co') || origin.username || origin.password || origin.port) {
    throw new Error('Cleanup origin unavailable')
  }
  async function database(path, method = 'GET', body) {
    const target = new URL(origin.origin)
    const [pathname, search = ''] = path.split('?')
    target.pathname = pathname; target.search = search
    const response = await fetch(target, { method, headers: { apikey: serviceRole,
      Authorization: `Bearer ${serviceRole}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30_000), redirect: 'error' })
    if (!response.ok) throw new Error(`Bounded cleanup HTTP ${response.status}`)
    return response.status === 204 ? null : response.json()
  }
  const jobs = await database(`/rest/v1/jobs?select=id,principal_id&id=eq.${KNOWN_JOB}&limit=1`)
  if (jobs?.[0]?.id !== KNOWN_JOB || jobs[0].principal_id !== KNOWN_PRINCIPAL) throw new Error('Known cleanup authority mismatch')
  const result = await cleanupAcceptanceAccount({ database, principalId: KNOWN_PRINCIPAL, run: '37786907076' })
  console.log('CLOUD_CODE_SCOPED_CLEANUP ' + JSON.stringify(result))
  if (!result.ok) process.exitCode = 1
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  standalone().catch(error => {
    console.error('CLOUD_CODE_SCOPED_CLEANUP ' + JSON.stringify({ ok: false, errorType: error.name }))
    process.exitCode = 1
  })
}
