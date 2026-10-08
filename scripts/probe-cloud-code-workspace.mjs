import { randomUUID, randomBytes } from 'node:crypto'
import { sealGitHubCredential } from '../lib/github-credential.ts'
import { runCloudCodeMcpAcceptance } from './cloud-code-mcp-acceptance.mjs'
import { cleanupAcceptanceAccount, provisionAcceptanceQuota, safeAcceptanceApiFailure } from './cleanup-cloud-code-acceptance.mjs'

// Only workflow_dispatch runs this bounded production acceptance. No real
// user's credentials or rows are read. Tokens never leave process memory.
const base = process.env.PRODUCTION_URL
const repo = process.env.GITHUB_REPOSITORY
const githubToken = process.env.GITHUB_TOKEN
const run = `${process.env.GITHUB_RUN_ID}-${randomUUID().slice(0, 8)}`
const branch = `cloud-acceptance/${run}`
const fixture = `diagnostics/cloud-code/${run}/fixture.mjs`
const tasks = []
let account
let config
let stage = 'configuration'
const report = { run, repo, branch, fixture, tasks: [], ok: false }

async function responseJson(response, label) {
  if (!response.ok) throw new Error(`${label}: HTTP ${response.status}`)
  return response.status === 204 ? null : response.json()
}
async function envValue(name, optional = false) {
  const response = await fetch(`https://api.render.com/v1/services/${process.env.RENDER_SERVICE_ID}/env-vars/${name}`, {
    headers: { Authorization: `Bearer ${process.env.RENDER_API_KEY}` }, signal: AbortSignal.timeout(30_000),
  })
  if (optional && response.status === 404) return ''
  const body = await responseJson(response, 'Server configuration')
  if (typeof body.value !== 'string' || (!optional && !body.value)) throw new Error('Missing server configuration')
  return body.value
}
async function github(path, method = 'GET', body) {
  return responseJson(await fetch(`https://api.github.com/repos/${repo}${path ? `/${path}` : ''}`, {
    method, headers: { Authorization: `Bearer ${githubToken}`, Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json', 'User-Agent': 'mychat-cloud-acceptance' },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30_000), redirect: 'error',
  }), 'Acceptance GitHub operation')
}
async function database(path, method = 'GET', body, admin = false) {
  return responseJson(await fetch(`${config.url}${path}`, {
    method, headers: { apikey: admin ? config.serviceRole : config.anonKey,
      Authorization: `Bearer ${admin ? config.serviceRole : account.token}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30_000),
  }), 'Acceptance database operation')
}
async function api(path, method = 'GET', body, expected = 200) {
  const response = await fetch(`${base}${path}`, {
    method, headers: { Authorization: `Bearer ${account.token}`, 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30_000),
  })
  if (response.status !== expected) {
    const failure = await response.json().catch(() => null)
    const error = new Error(`Acceptance API ${path}: HTTP ${response.status}`)
    error.safeDiagnostics = safeAcceptanceApiFailure(response, failure, path)
    report.apiFailures ??= []
    report.apiFailures.push(error.safeDiagnostics)
    throw error
  }
  return response.json()
}
async function createAccount() {
  const email = `cloud-code-probe-${randomUUID()}@example.com`
  const password = randomBytes(24).toString('base64url')
  const user = await database('/auth/v1/admin/users', 'POST', { email, password, email_confirm: true }, true)
  account = { id: user.id }
  const session = await responseJson(await fetch(`${config.url}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: config.anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }), signal: AbortSignal.timeout(30_000),
  }), 'Acceptance sign-in')
  account.token = session.access_token
  report.testQuota = await provisionAcceptanceQuota(database, account.id)
  const metadata = await github('')
  const identity = metadata.owner
  await database('/rest/v1/rpc/upsert_github_connection', 'POST', {
    input_user_id: account.id, input_github_user_id: identity.id, input_login: identity.login,
    input_credential_ciphertext: sealGitHubCredential(githubToken, { userId: account.id, login: identity.login }),
    input_scopes: ['repo'], input_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    input_actor_id: account.id, input_request_id: `cloud-acceptance-${run}`,
  }, true)
  return metadata
}
async function submit(marker) {
  const sessionId = randomUUID(), taskId = randomUUID(), responseId = randomUUID()
  const prompt = `这是授权的单文件云验收。只允许修改 ${fixture}，不改变其他文件、不部署、不合并。读取真实文件，把sum(a,b)修复成相加并加入独立标记 ${marker}。使用 execute 运行 node ${fixture}，再使用 verify 的 command 参数运行相同命令。用 git_diff 查看唯一文件差异，然后 publish(deploy_pages=false) 等待人工批准。不要调用其他外部工具。`
  await database('/rest/v1/code_sessions', 'POST', { id: sessionId, user_id: account.id, repo, title: `Cloud acceptance ${marker}` })
  await database('/rest/v1/code_messages', 'POST', { id: randomUUID(), session_id: sessionId, user_id: account.id,
    role: 'user', content: prompt, meta: { taskId } })
  const admission = await api('/api/code/chat', 'POST', { repo, branch, mode: 'code',
    modelId: 'anthropic/claude-haiku-5.5', reasoningEffort: 'medium', sessionId, taskId, responseId,
    messages: [{ role: 'user', content: prompt }] }, 202)
  const task = { ...admission, sessionId, marker }
  tasks.push(task)
  return task
}
async function disconnect(task) {
  const response = await fetch(`${base}${task.streamUrl}`, {
    headers: { Authorization: `Bearer ${account.token}` }, signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error('SSE admission failed')
  const reader = response.body.getReader()
  await reader.read()
  await reader.cancel()
}
async function waitJob(jobId, deadlineMs = 600_000) {
  const deadline = Date.now() + deadlineMs
  while (Date.now() < deadline) {
    const snapshot = await api(`/api/v1/jobs/${jobId}`)
    if (['completed', 'failed', 'cancelled', 'awaiting_input'].includes(snapshot.job.status)) return snapshot.job
    await new Promise(resolve => setTimeout(resolve, 10_000))
  }
  throw new Error('Cloud task deadline exceeded')
}
async function replay(task) {
  const response = await fetch(`${base}/api/v1/jobs/${task.jobId}/events?from_seq=0`, {
    headers: { Authorization: `Bearer ${account.token}` }, signal: AbortSignal.timeout(60_000),
  })
  if (!response.ok) throw new Error('Durable replay unavailable')
  const events = [], decoder = new TextDecoder()
  let buffer = ''
  for await (const bytes of response.body) {
    buffer += decoder.decode(bytes, { stream: true }).replace(/\r\n/g, '\n')
    let end
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2)
      const event = parseAcceptanceFrame(frame)
      if (event) events.push(event)
    }
    if (events.some(event => event.kind === 'job.terminal')) break
  }
  const sequence = events.map(event => event.seq)
  if (sequence.some((seq, index) => index > 0 && seq <= sequence[index - 1])) throw new Error('Replay sequence is not monotonic')
  const requested = events.filter(event => event.kind === 'tool.requested').map(event => event.payload.toolName)
  for (const name of ['read_file', 'execute', 'verify', 'git_diff', 'publish']) if (!requested.includes(name)) throw new Error(`Actual tool missing: ${name}`)
  return { eventCount: events.length, eventSequence: sequence.at(-1), requested }
}
function parseAcceptanceFrame(frame) {
  const data = frame.replace(/\r\n/g, '\n').split('\n').filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trim()).join('\n')
  try { const event = JSON.parse(data); return Number.isSafeInteger(event.seq) && event.seq > 0 ? event : null }
  catch { return null }
}
async function requestApproval(task) {
  const detail = await api(`/api/code/tasks/${task.taskId}`)
  const diff = await api(`/api/agent/tasks/${task.taskId}/workspace/diff`)
  if (detail.task?.repo !== repo || detail.task?.branch !== branch || !diff.manifestDigest
    || diff.head !== report.fixtureCommitSha
    || !diff.hasChanges || diff.changedFiles?.length !== 1 || diff.changedFiles[0].path !== fixture
    || diff.changedFiles[0].status === 'deleted') throw new Error('Pre-publication authority exceeds acceptance branch/file scope')
  return api('/api/code/apply', 'POST', { taskId: task.taskId, repo, mode: 'workspace_pr',
    actions: [], message: `Cloud acceptance ${run} ${task.marker}` }, 409)
}
async function main() {
  if (base !== 'https://mychat-nm6x.onrender.com' || !repo || repo !== process.env.CODE_PROBE_REPOSITORY
    || !githubToken || !process.env.RENDER_API_KEY || !/^srv-[a-z0-9]+$/.test(process.env.RENDER_SERVICE_ID ?? '')
    || process.env.CODE_PROBE_CONFIRM_PR !== 'true') throw new Error('Bounded cloud acceptance configuration unavailable')
  stage = 'isolated-account'
  const [url, anonKey, serviceRole, dedicated, fallback] = await Promise.all([
    envValue('NEXT_PUBLIC_SUPABASE_URL'), envValue('NEXT_PUBLIC_SUPABASE_ANON_KEY'), envValue('SUPABASE_SERVICE_ROLE_KEY'),
    envValue('AGENT_CREDENTIAL_KEY', true), envValue('GITHUB_CLIENT_SECRET', true),
  ])
  config = { url, anonKey, serviceRole }
  process.env.AGENT_CREDENTIAL_KEY = dedicated; process.env.GITHUB_CLIENT_SECRET = fallback
  const metadata = await createAccount()
  stage = 'product-mcp-install-and-model-call'
  report.mcp = await runCloudCodeMcpAcceptance({ api, run,
    modelId: 'anthropic/claude-haiku-5.5', disposableAccount: true,
    waitJob, registerTask: task => tasks.push(task),
    createCodeSession: async ({ sessionId, taskId, userMessageId, repo: codeRepo, prompt }) => {
      await database('/rest/v1/code_sessions', 'POST', { id: sessionId, user_id: account.id,
        repo: codeRepo, title: 'Public MCP Code acceptance' })
      await database('/rest/v1/code_messages', 'POST', { id: userMessageId, session_id: sessionId,
        user_id: account.id, role: 'user', content: prompt, meta: { taskId } })
    },
  })
  stage = 'single-file-fixture'
  const reference = await github(`git/ref/heads/${encodeURIComponent(metadata.default_branch)}`)
  await github('git/refs', 'POST', { ref: `refs/heads/${branch}`, sha: reference.object.sha })
  const content = `import assert from 'node:assert/strict';\nexport const sum = (a,b) => a-b;\nassert.equal(sum(2,4),6);\nconsole.log('CLOUD_ACCEPTANCE_NODE_OK');\n`
  const seeded = await github(`contents/${fixture}`, 'PUT', { branch, message: `Add isolated cloud acceptance fixture ${run}`, content: Buffer.from(content).toString('base64') })
  report.fixtureCommitSha = seeded.commit.sha
  stage = 'parallel-model-tasks'
  const a = await submit(`PROBE_A_${run}`), b = await submit(`PROBE_B_${run}`)
  await Promise.all([disconnect(a), disconnect(b)])
  report.offlineStartedAt = new Date().toISOString()
  console.log('CLOUD_WORKSPACE_PROGRESS ' + JSON.stringify({ run, stage: 'SSE-disconnected-15-minutes', taskIds: tasks.map(task => task.taskId) }))
  // Intentionally no API polling during the offline interval.
  await new Promise(resolve => setTimeout(resolve, 900_000))
  report.offlineFinishedAt = new Date().toISOString()
  stage = 'durable-recovery-and-isolation'
  for (const task of [a, b]) {
    const job = await waitJob(task.jobId)
    if (job.status !== 'completed') throw new Error(`Model task failed: ${job.errorCode ?? job.status}`)
    const recovered = await api(`/api/code/tasks?sessionId=${task.sessionId}`)
    if (recovered.admission?.jobId !== task.jobId) throw new Error('Recovery created or selected another job')
    const evidence = await replay(task)
    const calls = recovered.task.toolCalls
    const output = JSON.stringify(calls)
    if (!output.includes('CLOUD_ACCEPTANCE_NODE_OK') || !output.includes(task.marker)) throw new Error('Actual cloud test or independent marker missing')
    const other = task === a ? b.marker : a.marker
    const diffCall = calls.findLast(call => call.toolName === 'git_diff')
    const diff = JSON.stringify(diffCall?.output ?? {})
    if (!diff.includes(fixture) || !diff.includes(task.marker) || diff.includes(other)) throw new Error('Parallel workspace diff isolation failed')
    const gate = await requestApproval(task)
    if (!gate.needsConfirmation || !gate.confirmationToken) throw new Error('Publication approval absent')
    await api(`/api/agent/tasks/${task.taskId}/confirm`, 'POST', { action: 'reject', operation: gate.operation,
      confirmationId: gate.confirmationId, confirmationToken: gate.confirmationToken, reason: 'Acceptance rejection test' })
    const denied = await api('/api/code/apply', 'POST', { taskId: task.taskId, repo, mode: 'workspace_pr', actions: [],
      message: `Cloud acceptance ${run} ${task.marker}`, confirmation: { confirmationId: gate.confirmationId, confirmationToken: gate.confirmationToken } }, 409)
    if (denied.jobId) throw new Error('Rejected approval executed publication')
    report.tasks.push({ taskId: task.taskId, jobId: task.jobId, status: job.status, ...evidence, approvalRejected: true })
  }
  stage = 'explicitly-approved-acceptance-pr'
  report.cloudCorePassed = true
  const gate = await requestApproval(a)
  await api(`/api/agent/tasks/${a.taskId}/confirm`, 'POST', { action: 'confirm', operation: gate.operation,
    confirmationId: gate.confirmationId, confirmationToken: gate.confirmationToken })
  const publishing = await api('/api/code/apply', 'POST', { taskId: a.taskId, repo, mode: 'workspace_pr', actions: [],
    message: `Cloud acceptance ${run} ${a.marker}`, confirmation: { confirmationId: gate.confirmationId, confirmationToken: gate.confirmationToken } }, 202)
  tasks.push(publishing)
  const publication = await waitJob(publishing.jobId)
  report.publication = { jobId: publishing.jobId, status: publication.status, errorCode: publication.errorCode,
    pullRequestVerified: false, merged: false }
  if (publication.status !== 'completed') throw new Error('Approved acceptance publication failed')
  const detail = await api(`/api/code/tasks/${a.taskId}`)
  const pullRequestUrl = detail.task.pullRequestUrl
  if (typeof pullRequestUrl !== 'string' || !pullRequestUrl.startsWith(`https://github.com/${repo}/pull/`)) throw new Error('Actual PR URL absent')
  const number = Number(pullRequestUrl.split('/').at(-1))
  const pr = await github(`pulls/${number}`)
  const changed = await github(`pulls/${number}/files`)
  if (pr.merged || pr.base.ref !== branch || changed.length !== 1 || changed[0].filename !== fixture
    || !changed[0].patch?.includes(a.marker) || changed[0].patch.includes(b.marker)) throw new Error('Acceptance PR exceeds single-file scope')
  report.pullRequestUrl = pullRequestUrl; report.publication.pullRequestVerified = true
  report.ok = report.mcp.ok === true
  if (!report.ok) process.exitCode = 1
}
main().catch(error => {
  report.stage = stage; report.error = error instanceof Error ? error.message : 'Unknown acceptance error'
  report.apiFailure = error.safeDiagnostics ?? null
  process.exitCode = 1
}).finally(async () => {
  report.admittedJobs = tasks.map(task => ({ jobId: task.jobId, taskId: task.taskId, sessionId: task.sessionId ?? null }))
  if (config && account?.id) {
    try {
      report.cleanup = await cleanupAcceptanceAccount({ database, principalId: account.id, run,
        verifyOldSession: account.token ? async () => {
          const response = await fetch(`${config.url}/auth/v1/user`, { headers: {
            apikey: config.anonKey, Authorization: `Bearer ${account.token}` }, signal: AbortSignal.timeout(15_000) })
          return response.status === 401 || response.status === 403
        } : null,
      })
      if (!report.cleanup.ok) process.exitCode = 1
    }
    catch { report.cleanupError = 'Scoped account deactivation requires retry; audit retained'; process.exitCode = 1 }
  }
  console.log('CLOUD_WORKSPACE_ACCEPTANCE ' + JSON.stringify(report))
})
