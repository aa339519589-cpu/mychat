import { randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'

const origin = 'https://mychat-nm6x.onrender.com'
const expectedRevision = 'dd8186889175'
const output = 'audit-output'
const report = { observedAt: new Date().toISOString(), expectedRevision, checks: [], cleanup: null }
mkdirSync(output, { recursive: true })

let supabaseURL
let anonKey
let serviceKey
let testUserId

function ensure(value, message) {
  if (!value) throw new Error(message)
}

async function timedFetch(url, options = {}) {
  return fetch(url, {
    ...options,
    signal: options.signal ?? AbortSignal.timeout(90_000),
  })
}

async function responseJSON(response) {
  const body = await response.json().catch(() => null)
  ensure(response.ok, `HTTP ${response.status}: ${body?.error?.message ?? body?.error ?? body?.message ?? 'request failed'}`)
  return body
}

async function renderEnv(name) {
  const response = await timedFetch(
    `https://api.render.com/v1/services/${process.env.RENDER_SERVICE_ID}/env-vars/${name}`,
    { headers: { Authorization: `Bearer ${process.env.RENDER_API_KEY}` } },
  )
  const result = await responseJSON(response)
  ensure(typeof result.value === 'string' && result.value, `${name} unavailable`)
  return result.value
}

function adminHeaders() {
  return {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
  }
}

async function api(user, path, method = 'GET', body) {
  return timedFetch(`${origin}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${user.token}`,
      'Content-Type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

async function rest(path, method, body) {
  const response = await timedFetch(`${supabaseURL}/rest/v1/${path}`, {
    method,
    headers: { ...adminHeaders(), Prefer: 'return=representation' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  ensure(response.ok, `Supabase ${method} HTTP ${response.status}`)
  return text ? JSON.parse(text) : null
}

async function createDisposableUser() {
  const email = `mychat-audit-${Date.now()}-${randomBytes(6).toString('hex')}@example.com`
  const password = `${randomBytes(32).toString('base64url')}!Aa2`
  const created = await responseJSON(await timedFetch(`${supabaseURL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: adminHeaders(),
    body: JSON.stringify({ email, password, email_confirm: true }),
  }))
  ensure(created.id, 'Disposable user missing')
  testUserId = created.id
  const session = await responseJSON(await timedFetch(`${supabaseURL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  }))
  ensure(session.access_token, 'Disposable authentication missing')
  return { id: created.id, token: session.access_token }
}

async function chat(user, model, prompt, projectId) {
  const conversationId = randomUUID()
  const generationId = randomUUID()
  const userMessageId = randomUUID()
  const assistantMessageId = randomUUID()
  const request = {
    modelId: model.id,
    messages: [{ id: userMessageId, role: 'user', content: prompt, ts: new Date().toISOString() }],
    searchMode: 'off',
    historyRetrieval: false,
    connectorIds: [],
    connectorAccessMode: 'always_available',
    renderEnabled: false,
    conversationId,
    generationId,
    userMessageId,
    assistantMessageId,
    turn: {
      schemaVersion: 1,
      createConversation: true,
      title: '项目记忆隔离验收',
      projectId,
      memoryEnabled: true,
    },
  }
  if (model.reasoningEfforts?.includes('none')) request.reasoningEffort = 'none'
  const admitted = await responseJSON(await api(user, '/api/chat', 'POST', request))
  ensure(admitted.jobId === generationId, 'Admission identity mismatch')

  let job
  for (let attempt = 0; attempt < 90; attempt++) {
    job = (await responseJSON(await api(user, `/api/v1/jobs/${generationId}`))).job
    if (['completed', 'failed', 'cancelled'].includes(job?.status)) break
    await new Promise(resolve => setTimeout(resolve, 2_000))
  }
  ensure(job?.status === 'completed', `Model job ${job?.status ?? 'missing'}/${job?.errorCode ?? 'no code'}`)
  const messages = await rest(`messages?id=eq.${assistantMessageId}&select=content`, 'GET')
  return messages[0]?.content ?? ''
}

async function cleanup() {
  if (!testUserId) return { attempted: false }
  const failedTables = []
  for (const table of ['memories', 'project_memories', 'mcp_connectors', 'conversations', 'projects']) {
    try {
      await rest(`${table}?user_id=eq.${encodeURIComponent(testUserId)}`, 'DELETE')
    } catch {
      failedTables.push(table)
    }
  }

  let response = await timedFetch(`${supabaseURL}/auth/v1/admin/users/${testUserId}`, {
    method: 'DELETE',
    headers: adminHeaders(),
  })
  let softDeleted = false
  if (response.status === 500) {
    response = await timedFetch(`${supabaseURL}/auth/v1/admin/users/${testUserId}`, {
      method: 'DELETE',
      headers: adminHeaders(),
      body: JSON.stringify({ should_soft_delete: true }),
    })
    softDeleted = response.ok
  }
  return {
    attempted: true,
    authUserDeleted: response.ok,
    softDeleted,
    failedTableCount: failedTables.length,
    failedTables,
  }
}

try {
  const readyResponse = await timedFetch(`${origin}/api/ready`)
  const readiness = await responseJSON(readyResponse)
  report.revision = readiness.revision
  ensure(readiness.revision === expectedRevision, `Expected ${expectedRevision}, received ${readiness.revision}`)

  ;[supabaseURL, anonKey, serviceKey] = await Promise.all([
    'NEXT_PUBLIC_SUPABASE_URL',
    'NEXT_PUBLIC_SUPABASE_ANON_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
  ].map(renderEnv))

  const user = await createDisposableUser()
  const models = await responseJSON(await api(user, '/api/models'))
  const model = models.models.find(value => value.access === 'quota' && value.tools && value.outputKind === 'chat')
  ensure(model, 'No configured base tool-capable model')
  report.model = model.id
  const preferences = await responseJSON(await api(user, '/api/profile/memory', 'PUT', { enabled: true }))
  ensure(preferences.enabled === true, 'Could not enable memory for the disposable account')

  const firstProject = randomUUID()
  const secondProject = randomUUID()
  const projectMarker = `青竹${randomBytes(5).toString('hex')}`
  const globalMarker = `枫叶${randomBytes(5).toString('hex')}`
  await rest('projects', 'POST', [
    { id: firstProject, user_id: user.id, name: '项目记忆验收甲' },
    { id: secondProject, user_id: user.id, name: '项目记忆验收乙' },
  ])
  await rest('project_memories', 'POST', {
    user_id: user.id,
    project_id: firstProject,
    content: `本项目的验收偏好图形是${projectMarker}。`,
    topic: '验收',
  })
  await responseJSON(await api(user, '/api/memories', 'POST', {
    content: `全局验收偏好图形是${globalMarker}。`,
    topic: '验收',
  }))

  const own = await chat(user, model, '本项目的验收偏好图形是什么？只回答名称。', firstProject)
  const unrelated = await chat(user, model, '本项目的验收偏好图形是什么？不知道就说不知道。', secondProject)
  ensure(own.includes(projectMarker), 'Model did not use the matching project memory')
  ensure(!own.includes(globalMarker), 'Global memory leaked into project context')
  ensure(!unrelated.includes(projectMarker) && !unrelated.includes(globalMarker), 'Memory leaked into an unrelated project')
  report.checks.push({
    name: 'model-project-memory-isolation',
    passed: true,
    matchingProjectMemoryUsed: true,
    globalMemoryKeptOut: true,
    unrelatedProjectMemoryKeptOut: true,
    outputCharacters: { own: own.length, unrelated: unrelated.length },
  })
} catch (error) {
  report.checks.push({ name: 'model-project-memory-isolation', passed: false, error: error.message })
  report.fatal = error.message
} finally {
  if (supabaseURL && serviceKey) {
    try {
      report.cleanup = await cleanup()
      ensure(report.cleanup.failedTableCount === 0 && report.cleanup.authUserDeleted, 'Disposable account cleanup incomplete')
    } catch (error) {
      report.cleanup = { attempted: true, error: error.message }
      report.fatal ??= error.message
    }
  }
  writeFileSync(`${output}/project-memory-report.json`, JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
  if (report.fatal || report.checks.some(check => !check.passed)) process.exitCode = 1
}
