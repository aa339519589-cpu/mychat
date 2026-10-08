import { randomUUID, randomBytes } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { performance } from 'node:perf_hooks'

const base = process.env.PRODUCTION_URL
const serviceId = process.env.RENDER_SERVICE_ID
const renderKey = process.env.RENDER_API_KEY
const cases = [
  { kind: 'text', model: 'anthropic/claude-sonnet-5.5', prompt: '请解释为什么月亮会有不同的形状，给出生活中的例子。' },
  { kind: 'photo', model: 'anthropic/claude-sonnet-5.5', prompt: '请描述图片中央的颜色和形状。' },
  { kind: 'web', model: 'anthropic/claude-sonnet-5.5', prompt: '请联网查询苹果官网现在在售哪些 iPhone，给出来源链接。' },
  { kind: 'text', model: 'anthropic/claude-haiku-5.5', prompt: '请解释为什么月亮会有不同的形状，给出生活中的例子。' },
  { kind: 'text', model: 'anthropic/claude-opus-5.5', prompt: '请解释为什么月亮会有不同的形状，给出生活中的例子。' },
  { kind: 'text', model: 'anthropic/claude-fable-5.1', prompt: '请解释为什么月亮会有不同的形状，给出生活中的例子。' },
]

async function json(response, stage) {
  if (!response.ok) throw new Error(`${stage} HTTP ${response.status}`)
  return response.json()
}

async function renderEnv(name) {
  const value = await json(await fetch(`https://api.render.com/v1/services/${serviceId}/env-vars/${name}`, {
    headers: { Authorization: `Bearer ${renderKey}` }, signal: AbortSignal.timeout(30_000),
  }), `Render ${name}`)
  if (typeof value.value !== 'string' || !value.value) throw new Error(`Missing ${name}`)
  return value.value
}

function crc32(bytes) {
  let value = 0xffffffff
  for (const byte of bytes) {
    value ^= byte
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0)
  }
  return (value ^ 0xffffffff) >>> 0
}

function pngChunk(type, bytes) {
  const name = Buffer.from(type)
  const length = Buffer.alloc(4); length.writeUInt32BE(bytes.length)
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(Buffer.concat([name, bytes])))
  return Buffer.concat([length, name, bytes, checksum])
}

function diagnosticPhoto() {
  const width = 512
  const pixels = Buffer.alloc(width * (width * 3 + 1))
  const noise = randomBytes(width * width * 3)
  for (let y = 0; y < width; y++) {
    for (let x = 0; x < width; x++) {
      const start = y * (width * 3 + 1) + 1 + x * 3
      const circle = (x - 256) ** 2 + (y - 256) ** 2 < 130 ** 2
      pixels[start] = circle ? 240 : noise[(y * width + x) * 3]
      pixels[start + 1] = circle ? 30 : noise[(y * width + x) * 3 + 1]
      pixels[start + 2] = circle ? 30 : noise[(y * width + x) * 3 + 2]
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0); header.writeUInt32BE(width, 4); header[8] = 8; header[9] = 2
  return 'data:image/png;base64,' + Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'),
    pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(pixels)), pngChunk('IEND', Buffer.alloc(0))]).toString('base64')
}

function eventData(frame) {
  const value = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
  try { return JSON.parse(value) } catch { return null }
}

function applyEvent(state, event, elapsed) {
  if (!event?.payload) return
  if (event.kind === 'text.delta' && event.payload.text) {
    state.firstTextMs ??= elapsed
    state.text += event.payload.text
    state.textEvents += 1
  }
  if (event.kind === 'tool.search') {
    const search = event.payload.search
    if (search?.kind === 'web') state.webSources += search.results?.length ?? 0
  }
  if (event.kind === 'job.terminal') {
    state.status = event.payload.status
    state.errorCode = event.payload.errorCode
    state.terminalMs = elapsed
    if (!state.text && event.payload.result?.content) state.text = event.payload.result.content
  }
}

async function consume(response, start) {
  const state = { firstTextMs: null, terminalMs: null, text: '', textEvents: 0, webSources: 0, status: null }
  let buffer = ''
  const decoder = new TextDecoder()
  for await (const bytes of response.body) {
    buffer += decoder.decode(bytes, { stream: true }).replace(/\r\n/g, '\n')
    let end
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      applyEvent(state, eventData(buffer.slice(0, end)), Math.round(performance.now() - start))
      buffer = buffer.slice(end + 2)
    }
    if (state.status) break
  }
  return state
}

async function account(config) {
  const email = `reply-probe-${randomUUID()}@example.com`
  const password = randomBytes(24).toString('base64url')
  const adminHeaders = { apikey: config.serviceRole, Authorization: `Bearer ${config.serviceRole}`, 'Content-Type': 'application/json' }
  const user = await json(await fetch(`${config.url}/auth/v1/admin/users`, {
    method: 'POST', headers: adminHeaders, body: JSON.stringify({ email, password, email_confirm: true }),
    signal: AbortSignal.timeout(30_000),
  }), 'Disposable account')
  try {
    const session = await json(await fetch(`${config.url}/auth/v1/token?grant_type=password`, {
      method: 'POST', headers: { apikey: config.anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }), signal: AbortSignal.timeout(30_000),
    }), 'Disposable sign-in')
    return { id: user.id, token: session.access_token, adminHeaders }
  } catch (error) {
    await fetch(`${config.url}/auth/v1/admin/users/${user.id}`, { method: 'DELETE', headers: adminHeaders })
    throw error
  }
}

async function probe(config, test) {
  const user = await account(config)
  const generationId = randomUUID()
  const userMessageId = randomUUID()
  const headers = { Authorization: `Bearer ${user.token}`, Accept: 'text/event-stream', 'Content-Type': 'application/json' }
  let reachedTerminal = false
  try {
    const photo = test.kind === 'photo' ? diagnosticPhoto() : null
    const body = { tier: '绝句', modelId: test.model, reasoningEffort: 'none',
      messages: [{ id: userMessageId, role: 'user', content: test.prompt, ts: new Date().toISOString(), ...(photo ? { images: [photo] } : {}) }],
      searchMode: test.kind === 'web' ? 'web' : 'off', historyRetrieval: false, renderEnabled: false,
      connectorIds: [], conversationId: randomUUID(), userMessageId, generationId, assistantMessageId: randomUUID(),
      turn: { schemaVersion: 1, createConversation: true, memoryEnabled: false, title: 'Reply path probe', projectId: null } }
    const start = performance.now()
    const response = await fetch(`${base}/api/chat`, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(150_000) })
    const admittedMs = Math.round(performance.now() - start)
    if (response.status !== 200) throw new Error(`Admission HTTP ${response.status}`)
    const state = await consume(response, start)
    reachedTerminal = ['completed', 'failed', 'cancelled'].includes(state.status)
    const result = { kind: test.kind, model: test.model, generationId, admittedMs,
      firstTextMs: state.firstTextMs, terminalMs: state.terminalMs, status: state.status,
      characters: state.text.length, textEvents: state.textEvents, webSources: state.webSources,
      photoChars: photo?.length ?? 0, errorCode: state.errorCode,
      ok: state.status === 'completed' && state.firstTextMs !== null && state.text.length > 10
        && (test.kind !== 'web' || state.webSources > 0)
        && (test.kind !== 'photo' || /红|red/i.test(state.text)) }
    console.log(`PRODUCTION_CHAT_PROBE ${JSON.stringify(result)}`)
    return result.ok
  } catch (error) {
    console.log(`PRODUCTION_CHAT_PROBE ${JSON.stringify({ kind: test.kind, model: test.model, generationId,
      ok: false, error: error instanceof Error ? error.message : 'unknown' })}`)
    return false
  } finally {
    if (!reachedTerminal) {
      await fetch(`${base}/api/v1/jobs/${generationId}/cancel`, { method: 'POST', headers,
        body: JSON.stringify({ reason: 'Diagnostic deadline' }), signal: AbortSignal.timeout(15_000) }).catch(() => undefined)
    }
    await fetch(`${config.url}/auth/v1/admin/users/${user.id}`, {
      method: 'DELETE', headers: user.adminHeaders, signal: AbortSignal.timeout(30_000),
    }).catch(() => undefined)
  }
}

async function main() {
  if (base !== 'https://mychat-nm6x.onrender.com' || !/^srv-[a-z0-9]+$/.test(serviceId ?? '') || !renderKey) throw new Error('Production probe configuration unavailable')
  const [url, anonKey, serviceRole] = await Promise.all(['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY'].map(renderEnv))
  const config = { url, anonKey, serviceRole }
  const snapshot = await json(await fetch(`${url}/rest/v1/rpc/read_billing_reconciliation_v1`, {
    method: 'POST', headers: { apikey: serviceRole, Authorization: `Bearer ${serviceRole}`, 'Content-Type': 'application/json' }, body: '{}',
    signal: AbortSignal.timeout(15_000),
  }), 'Billing snapshot')
  console.log('BILLING_PROBE ' + JSON.stringify({ healthy: snapshot.healthy, generatedAt: snapshot.generatedAt, totalMismatches: snapshot.totalMismatches }))
  let failures = 0
  for (const test of cases) { if (!await probe(config, test)) failures += 1 }
  if (failures) process.exitCode = 1
}

main().catch(error => { console.error(error instanceof Error ? error.message : 'Probe failed'); process.exitCode = 1 })
