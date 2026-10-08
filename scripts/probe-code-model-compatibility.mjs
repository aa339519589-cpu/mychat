// Review before running. Exactly one model POST; never runTurn/AgentLoop,
// tool execution, workspace creation, database mutation or provider fallback.
import { createHash } from 'node:crypto'
import { createCodeMcpBroker } from '../lib/code-tools/mcp-broker.ts'
import { buildCodeTools } from '../lib/code-tools/definitions.ts'
import { codePlanToolAllowed } from '../lib/code-agent/plan-policy.ts'
import { buildCodeSystem } from '../lib/code-agent/system-prompt.ts'
import { resolveCodeModelSelection } from '../lib/code-agent/model-selection.ts'
import { buildProviderRequest } from '../lib/llm/provider-adapters.ts'
import { redactSecrets } from '../lib/llm/stream.ts'

const JOB = 'fa56ac8d-562b-4085-85c8-f747d6aa4a39'
const RUN = '37786907076'
const SERVICE = 'srv-d8rs8te7r5hc73enrkm0'
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
const DISPOSABLE_EMAIL = /^cloud-code-probe-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}@example\.com$/i
const PUBLIC_MCP = ['https://developers.openai.com/mcp', 'https://mcp.context7.com/mcp']
const RESPONSE_BYTE_LIMIT = 8_192
const report = { knownJobId: JOB, run: RUN, ok: false, modelRequestCount: 0,
  toolExecutionCount: 0, databaseWriteCount: 0, responseByteLimit: RESPONSE_BYTE_LIMIT }
let config
const secrets = []

function code(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_.\[\]-]{1,120}$/.test(value) ? value : null
}
function safeMessage(value) {
  if (typeof value !== 'string') return null
  if (/"(?:messages|content)"\s*:/.test(value)) return 'provider-error-request-text-redacted'
  return redactSecrets(value, secrets)
    .replace(/https?:\/\/[^\s"'<>]+/gi, text => {
      try { const url = new URL(text); return `${url.origin}${url.pathname}` } catch { return '[URL]' }
    })
    .replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 400)
}
async function json(response, stage) {
  if (!response.ok) {
    const error = new Error(stage)
    error.safeStatus = response.status
    throw error
  }
  return response.json()
}
async function environment(name) {
  const response = await fetch(`https://api.render.com/v1/services/${SERVICE}/env-vars/${name}`, {
    headers: { Authorization: `Bearer ${process.env.RENDER_API_KEY}` },
    redirect: 'error', signal: AbortSignal.timeout(30_000),
  })
  const body = await json(response, 'server-configuration')
  if (typeof body?.value !== 'string' || !body.value) throw new Error('missing-configuration')
  secrets.push(body.value)
  return body.value
}
async function read(path) {
  return json(await fetch(`${config.origin}${path}`, {
    headers: { apikey: config.serviceRole, Authorization: `Bearer ${config.serviceRole}` },
    redirect: 'error', signal: AbortSignal.timeout(30_000),
  }), 'scoped-read')
}
function table(name, select, filters) {
  return `/rest/v1/${name}?${new URLSearchParams({ select, ...filters })}`
}
async function verifiedIdentity() {
  const [job] = await read(table('jobs',
    'id,principal_id,type,created_at,modelId:payload->>modelId,mode:payload->>mode,reasoningEffort:payload->>reasoningEffort,accessClass:payload->>accessClass',
    { id: `eq.${JOB}`, limit: '1' }))
  if (job?.id !== JOB || job.type !== 'agent.task' || job.mode !== 'plan'
    || job.modelId !== 'deepseek-v4-flash' || !UUID.test(job.principal_id ?? '')
    || typeof job.created_at !== 'string'
    || job.created_at < '2026-10-08T13:45:00Z' || job.created_at > '2026-10-08T13:48:00Z') {
    throw new Error('known-job-authority-mismatch')
  }
  const user = await read(`/auth/v1/admin/users/${job.principal_id}`)
  if (user?.id !== job.principal_id || !DISPOSABLE_EMAIL.test(user.email ?? '')
    || typeof user.created_at !== 'string'
    || user.created_at < '2026-10-08T13:45:00Z' || user.created_at > '2026-10-08T13:48:00Z') {
    throw new Error('not-disposable-acceptance-principal')
  }
  return job
}
async function planCatalog(job) {
  const rows = await read(table('mcp_connectors', 'id,user_id,name,server_url,enabled,auth_type,tools', {
    user_id: `eq.${job.principal_id}`, enabled: 'eq.true', auth_type: 'eq.none', limit: '10',
  }))
  if (rows.length !== 2 || PUBLIC_MCP.some(url => !rows.some(row => row.server_url === url))) {
    throw new Error('expected-two-public-installations-not-found')
  }
  const connectors = rows.map(row => {
    if (!UUID.test(row.id ?? '') || row.user_id !== job.principal_id || row.auth_type !== 'none'
      || !row.enabled || !Array.isArray(row.tools) || !PUBLIC_MCP.includes(row.server_url)) {
      throw new Error('connector-authority-mismatch')
    }
    return { id: row.id, userId: row.user_id, name: row.name, serverUrl: row.server_url,
      enabled: true, accessToken: null, tools: row.tools }
  })
  const broker = await createCodeMcpBroker({ userId: job.principal_id, mode: 'plan',
    loadConnectors: async () => connectors, allowExternalNetwork: true })
  if (broker.connectionHealth().length !== 2 || broker.connectionHealth().some(item => item.status !== 'available')) {
    throw new Error('public-mcp-catalog-discovery-unavailable')
  }
  const remote = broker.listTools()
  const tools = buildCodeTools({ isWorkspace: false, canExecute: false, executePermission: '',
    allowExternalNetwork: true, memoryEnabled: false, remoteTools: remote,
  }).filter(tool => codePlanToolAllowed(tool.function.name)
    || remote.some(item => item.toolId === tool.function.name && !item.approvalRequired))
  report.catalog = tools.map(tool => ({ name: tool.function.name,
    schemaHash: createHash('sha256').update(JSON.stringify(tool.function.parameters)).digest('hex'),
    schemaKeys: Object.keys(tool.function.parameters).sort(),
    schemaVersion: safeMessage(tool.function.parameters.$schema) }))
  report.catalogHash = createHash('sha256').update(JSON.stringify(tools)).digest('hex')
  report.publicMcpToolCount = remote.length
  return tools
}
function classify(status, error) {
  if (error && (status === 400 || status === 422)) return 'provider-request-or-schema-rejected'
  if ([401, 403].includes(status)) return 'provider-auth-or-permission-rejected'
  if (status === 402) return 'provider-credit-or-output-reservation-rejected'
  if (status === 429) return 'provider-rate-or-credit-rejected'
  if (status >= 500) return 'provider-unavailable'
  if (error) return status >= 400 ? 'provider-http-rejected' : 'provider-stream-error'
  return status >= 400 ? 'provider-http-rejected' : 'provider-request-accepted'
}
function acceptPayload(payload, evidence) {
  if (!payload || typeof payload !== 'object') return false
  const upstream = payload.error
  if (upstream) evidence.upstreamError = { type: code(upstream.type), code: code(upstream.code),
    param: code(upstream.param), message: safeMessage(typeof upstream === 'string' ? upstream : upstream.message ?? payload.message) }
  const choice = Array.isArray(payload.choices) ? payload.choices[0] : null
  if (typeof choice?.finish_reason === 'string') evidence.finishReason = code(choice.finish_reason)
  const delta = choice?.delta ?? choice?.message
  if (Array.isArray(delta?.tool_calls)) for (const call of delta.tool_calls) {
    const name = code(call.function?.name)
    if (name) evidence.returnedToolNames.push(name)
  }
  if (typeof payload.usage?.total_tokens === 'number') evidence.totalTokens = payload.usage.total_tokens
  // Abort on any semantic result: compatibility is established without
  // executing or printing returned tool arguments, reasoning or model text.
  return Boolean(upstream || evidence.finishReason || evidence.returnedToolNames.length || delta?.content)
}
async function readResponse(response, controller) {
  const evidence = { httpStatus: response.status,
    contentType: response.headers.get('content-type')?.split(';')[0] ?? null,
    upstreamRequestId: code(response.headers.get('x-request-id') ?? response.headers.get('request-id')),
    responseBytesRead: 0, finishReason: null, returnedToolNames: [], stoppedAtSemanticResult: false,
  }
  const reader = response.body?.getReader()
  if (!reader) return { ...evidence, failureCategory: 'provider-response-has-no-body' }
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      const remaining = RESPONSE_BYTE_LIMIT - evidence.responseBytesRead
      evidence.responseBytesRead += Math.min(value.byteLength, remaining)
      buffer += decoder.decode(value.subarray(0, remaining), { stream: true })
      const jsonBody = evidence.contentType === 'application/json'
      const lines = jsonBody ? [] : buffer.split(/\r?\n/)
      if (!jsonBody) buffer = lines.pop() ?? ''
      let stop = false
      for (const line of lines) {
        const raw = line.startsWith('data:') ? line.slice(5).trim() : line.trim()
        if (raw === '[DONE]') { stop = true; break }
        try { if (acceptPayload(JSON.parse(raw), evidence)) stop = true } catch { /* framing */ }
      }
      if (stop || evidence.responseBytesRead >= RESPONSE_BYTE_LIMIT) {
        evidence.stoppedAtSemanticResult = stop
        await reader.cancel().catch(() => undefined); controller.abort(); break
      }
    }
    if (buffer.trim()) {
      const raw = buffer.trim().replace(/^data:\s*/, '')
      try { acceptPayload(JSON.parse(raw), evidence) } catch { /* never print raw body */ }
    }
  } finally { reader.releaseLock() }
  evidence.failureCategory = classify(response.status, evidence.upstreamError)
  return evidence
}
async function main() {
  if (process.env.PRODUCTION_URL !== 'https://mychat-nm6x.onrender.com'
    || process.env.RENDER_SERVICE_ID !== SERVICE || !process.env.RENDER_API_KEY
    || process.env.CODE_MODEL_COMPATIBILITY_CONFIRM_ONCE !== `${RUN}:${JOB}`) {
    throw new Error('explicit-single-request-diagnostic-confirmation-required')
  }
  secrets.push(process.env.RENDER_API_KEY)
  const [originValue, serviceRole, key] = await Promise.all([
    environment('NEXT_PUBLIC_SUPABASE_URL'), environment('SUPABASE_SERVICE_ROLE_KEY'), environment('DEEPSEEK_API_KEY'),
  ])
  const origin = new URL(originValue)
  if (origin.protocol !== 'https:' || !origin.hostname.endsWith('.supabase.co')
    || origin.username || origin.password || origin.port || origin.search || origin.hash) throw new Error('unexpected-database-origin')
  config = { origin: origin.origin, serviceRole }
  const job = await verifiedIdentity()
  const tools = await planCatalog(job)
  process.env.DEEPSEEK_API_KEY = key
  const selection = await resolveCodeModelSelection({ modelId: job.modelId,
    reasoningEffort: job.reasoningEffort ?? undefined, supabase: null, userId: job.principal_id, allowPremium: true })
  if (selection.capability.provider.adapter !== 'deepseek-openai' || selection.model !== 'deepseek-v4-flash'
    || selection.capability.provider.baseUrl !== 'https://api.deepseek.com') throw new Error('unexpected-model-route')
  const maximum = job.accessClass === 'trial' ? 10_000 : 40_000
  const request = buildProviderRequest(selection.capability.provider.adapter, {
    model: selection.model, tools, apiKey: key, authType: selection.authType,
    thinking: selection.thinking, reasoningEffort: selection.reasoningEffort,
    maxOutputTokens: maximum, messages: [
      { role: 'system', content: buildCodeSystem('DeepSeek V4 Flash', null, 'cloud-code-acceptance', [], 'plan', false, [], false, false, true) },
      { role: 'user', content: '这是一次工具Schema兼容性诊断。只调用 complete，禁止调用其他工具，不输出推理，最终回答不超过10字。' },
    ],
  })
  report.model = selection.model; report.adapter = selection.capability.provider.adapter
  report.requestedMaxOutputTokens = maximum; report.thinking = selection.thinking
  report.reasoningEffort = selection.reasoningEffort ?? null
  report.requestBodyKeys = Object.keys(request.body).sort()
  secrets.push(...request.body.messages.map(message => message.content).filter(value => typeof value === 'string'))
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30_000)
  try {
    report.modelRequestCount++
    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST', headers: request.headers, body: JSON.stringify(request.body),
      signal: controller.signal, redirect: 'error',
    })
    report.response = { httpStatus: response.status, contentType: response.headers.get('content-type')?.split(';')[0] ?? null }
    report.response = await readResponse(response, controller)
    report.ok = true
  } finally { clearTimeout(timeout); controller.abort() }
  console.log('CODE_MODEL_COMPATIBILITY_DIAG ' + JSON.stringify(report))
}
main().catch(error => {
  report.failure = { stage: code(error.message) ?? 'diagnostic-operation-failed',
    errorType: code(error.name), httpStatus: error.safeStatus ?? null }
  console.error('CODE_MODEL_COMPATIBILITY_DIAG ' + JSON.stringify(report))
  process.exitCode = 1
})
