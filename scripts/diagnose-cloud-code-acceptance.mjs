// Read-only diagnosis of one already-authorized disposable acceptance principal.
// No model call, database mutation, credential row, payload, tool output or token is read.
const PROBE_JOB = 'fa56ac8d-562b-4085-85c8-f747d6aa4a39'
const PROBE_RUN = '37786907076'
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
const DISPOSABLE_EMAIL = /^cloud-code-probe-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}@example\.com$/i
let config

function safeCode(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(value) ? value : null
}
function safeErrorCategory(value) {
  if (typeof value !== 'string' || !value) return null
  const categories = [
    ['insufficient_credit', /insufficient_job_credit|insufficient.*credit|quota|额度/i],
    ['model_policy_changed', /model policy changed|模型策略.*变化/i],
    ['provider_unconfigured', /provider is not configured|API.*key.*unavailable|未配置|not configured/i],
    ['github_authorization', /github|credential|凭据|授权/i],
    ['mcp_transport_or_schema', /mcp|schema|工具.*格式/i],
    ['lease_or_recovery', /lease|checkpoint|fence|恢复/i],
    ['cancelled', /cancel|取消/i],
    ['upstream_network', /timeout|timed out|fetch failed|ECONN|upstream|network/i],
  ]
  return categories.find(([, pattern]) => pattern.test(value))?.[0] ?? 'unclassified_error_redacted'
}
async function responseJson(response, stage) {
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    const error = new Error(stage)
    error.safeDiagnostics = { stage, httpStatus: response.status, code: safeCode(body?.code),
      errorCategory: safeErrorCategory(body?.message ?? body?.msg ?? body?.error_description) }
    throw error
  }
  return body
}
async function serverEnvironment(name) {
  const response = await fetch(`https://api.render.com/v1/services/${process.env.RENDER_SERVICE_ID}/env-vars/${name}`, {
    headers: { Authorization: `Bearer ${process.env.RENDER_API_KEY}` },
    signal: AbortSignal.timeout(30_000), redirect: 'error',
  })
  const body = await responseJson(response, 'server-configuration')
  if (typeof body?.value !== 'string' || !body.value) throw new Error('Missing configuration')
  return body.value
}
async function read(path) {
  const target = new URL(config.url)
  target.pathname = path.split('?')[0]
  target.search = path.includes('?') ? path.slice(path.indexOf('?') + 1) : ''
  return responseJson(await fetch(target, {
    method: 'GET', headers: { apikey: config.serviceRole, Authorization: `Bearer ${config.serviceRole}` },
    signal: AbortSignal.timeout(30_000), redirect: 'error',
  }), 'scoped-read')
}
function tablePath(table, select, filters) {
  const query = new URLSearchParams({ select, ...filters })
  return `/rest/v1/${table}?${query}`
}
async function principalFromKnownJob() {
  const rows = await read(tablePath('jobs', 'id,principal_id,type,status,created_at', { id: `eq.${PROBE_JOB}`, limit: '1' }))
  const job = rows?.[0]
  if (job?.id !== PROBE_JOB || job.type !== 'agent.task' || !UUID.test(job.principal_id ?? '')
    || job.created_at < '2026-10-08T13:45:00Z' || job.created_at > '2026-10-08T13:48:00Z') {
    throw new Error('Known acceptance job authority mismatch')
  }
  const identity = await read(`/auth/v1/admin/users/${job.principal_id}`)
  if (identity?.id !== job.principal_id || !DISPOSABLE_EMAIL.test(identity.email ?? '')) {
    throw new Error('Principal is not the authorized disposable acceptance account')
  }
  return { principalId: job.principal_id, disposable: true, emailVerifiedAgainstPattern: true,
    banned: typeof identity.banned_until === 'string' && Date.parse(identity.banned_until) > Date.now() }
}
async function scopedEvidence(principalId) {
  const filters = { principal_id: `eq.${principalId}`, limit: '20', order: 'created_at.asc' }
  const [jobs, tasks, calls, reservations, profiles, activations, prices] = await Promise.all([
    read(tablePath('jobs', 'id,type,status,error_code,error_class,attempt,max_attempts,created_at,started_at,terminal_at,event_sequence,cancel_requested_at', filters)),
    read(tablePath('agent_tasks', 'id,mode,status,error,branch,created_at,started_at,finished_at',
      { user_id: `eq.${principalId}`, limit: '20', order: 'created_at.asc' })),
    read(tablePath('agent_tool_calls', 'id,task_id,tool_name,status,error,duration_ms,seq',
      { user_id: `eq.${principalId}`, limit: '100', order: 'seq.asc' })),
    read(tablePath('job_admission_reservations', 'job_id,sku,price_version,funding,status,reserved_tokens,actual_tokens,released_tokens,reserved_cost_micros,created_at', filters)),
    read(tablePath('profiles', 'limit_5h,limit_week,balance,quota_version', { user_id: `eq.${principalId}`, limit: '1' })),
    read(tablePath('job_price_activation_heads', 'sku,price_version,activation_generation', { sku: 'eq.agent.task', limit: '1' })),
    read(tablePath('job_price_catalog', 'sku,version,default_reserve_tokens,raw_token_cap,token_multiplier_millis,reserve_cost_micros', { sku: 'eq.agent.task', limit: '10' })),
  ])
  const events = await read(tablePath('job_events', 'seq,kind', {
    job_id: `eq.${PROBE_JOB}`, principal_id: `eq.${principalId}`, limit: '200', order: 'seq.asc',
  }))
  const profile = profiles[0] ?? null
  const heldQuotaTokens = reservations.filter(row => row.status === 'held' && row.funding === 'quota')
    .reduce((total, row) => total + Number(row.reserved_tokens), 0)
  const activation = activations[0] ?? null
  const price = prices.find(row => row.version === activation?.price_version) ?? null
  return {
    jobs: jobs.map(row => ({ ...row, error_code: safeCode(row.error_code), error_class: safeCode(row.error_class) })),
    tasks: tasks.map(({ error, ...row }) => ({ ...row, errorCategory: safeErrorCategory(error) })),
    toolCalls: calls.map(({ error, ...row }) => ({ ...row, tool_name: safeCode(row.tool_name), errorCategory: safeErrorCategory(error) })),
    reservations, profile, activation, price, heldQuotaTokens,
    defaultSingleTaskReserveFits: profile && price ? heldQuotaTokens + price.default_reserve_tokens <= profile.limit_5h : null,
    samePrincipalTwoTaskReserveFits: profile && price ? heldQuotaTokens + 2 * price.default_reserve_tokens <= profile.limit_5h : null,
    eventKindCounts: Object.fromEntries([...new Set(events.map(event => safeCode(event.kind)))].filter(Boolean)
      .map(kind => [kind, events.filter(event => event.kind === kind).length])),
    eventRowsLimited: events.length === 200,
    deletionRestrictedByExistingJobAudit: jobs.length > 0,
  }
}
async function main() {
  if (process.env.PRODUCTION_URL !== 'https://mychat-nm6x.onrender.com'
    || !/^srv-[a-z0-9]+$/.test(process.env.RENDER_SERVICE_ID ?? '') || !process.env.RENDER_API_KEY) {
    throw new Error('Diagnostic configuration unavailable')
  }
  const [url, serviceRole] = await Promise.all([
    serverEnvironment('NEXT_PUBLIC_SUPABASE_URL'), serverEnvironment('SUPABASE_SERVICE_ROLE_KEY'),
  ])
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:' || !parsed.hostname.endsWith('.supabase.co')
    || parsed.username || parsed.password || parsed.port) throw new Error('Unexpected diagnostic database origin')
  config = { url: parsed.origin, serviceRole }
  const identity = await principalFromKnownJob()
  const evidence = await scopedEvidence(identity.principalId)
  console.log('CLOUD_CODE_READONLY_DIAG ' + JSON.stringify({ ok: true, run: PROBE_RUN,
    knownJobId: PROBE_JOB, identity, ...evidence }))
}
main().catch(error => {
  console.error('CLOUD_CODE_READONLY_DIAG ' + JSON.stringify({ ok: false, run: PROBE_RUN,
    knownJobId: PROBE_JOB, failure: error.safeDiagnostics ?? { errorType: error.name } }))
  process.exitCode = 1
})
