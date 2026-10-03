import { randomUUID, randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const origin = 'https://mychat-nm6x.onrender.com'
const report = { observedAt: new Date().toISOString(), phase: process.env.AUDIT_PHASE ?? 'before-release', checks: [] }
const output = 'audit-output'
mkdirSync(output, { recursive: true })
const users = []
let sb, anon, service
const timedFetch = (url, options = {}) => fetch(url, { ...options, signal: AbortSignal.timeout(90_000) })
function ensure(value, message) { if (!value) throw new Error(message) }
async function json(response) {
  const body = await response.json().catch(() => null)
  ensure(response.ok, `HTTP ${response.status}`)
  return body
}
async function check(name, fn) {
  try { const details = await fn(); report.checks.push({ name, passed: true, ...details }) }
  catch (error) { report.checks.push({ name, passed: false, error: error.message }) }
}
async function renderEnv(name) {
  const result = await json(await timedFetch(`https://api.render.com/v1/services/${process.env.RENDER_SERVICE_ID}/env-vars/${name}`, {
    headers: { Authorization: `Bearer ${process.env.RENDER_API_KEY}` },
  }))
  ensure(typeof result.value === 'string' && result.value, `${name} unavailable`)
  return result.value
}
function adminHeaders() { return { apikey: service, Authorization: `Bearer ${service}`, 'Content-Type': 'application/json' } }
async function account() {
  const email = `mychat-audit-${Date.now()}-${randomBytes(6).toString('hex')}@example.com`
  const password = `${randomBytes(32).toString('base64url')}!Aa2`
  const created = await json(await timedFetch(`${sb}/auth/v1/admin/users`, {
    method: 'POST', headers: adminHeaders(), body: JSON.stringify({ email, password, email_confirm: true }),
  }))
  ensure(created.id, 'Disposable user missing'); users.push(created.id)
  const signed = await json(await timedFetch(`${sb}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: anon, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }),
  }))
  ensure(signed.access_token, 'Disposable authentication missing')
  return { id: created.id, token: signed.access_token, refreshToken: signed.refresh_token }
}
async function api(user, path, method = 'GET', body) {
  return timedFetch(`${origin}${path}`, { method,
    headers: { Authorization: `Bearer ${user.token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
}
async function rest(table, method, body) {
  return json(await timedFetch(`${sb}/rest/v1/${table}`, { method, headers: { ...adminHeaders(), Prefer: 'return=representation' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) }))
}
try {
  await check('production-readiness', async () => {
    const response = await timedFetch(`${origin}/api/ready`)
    const body = await response.json()
    report.readiness = body
    ensure(response.ok, `Readiness HTTP ${response.status}`)
  })
  await check('migration-authority', async () => {
    ensure(process.env.SUPABASE_ACCESS_TOKEN, 'SUPABASE_ACCESS_TOKEN unavailable')
    const result = await json(await timedFetch('https://api.supabase.com/v1/projects/usibkqqksgwgvdiqwpyo/database/query', {
      method: 'POST', headers: { Authorization: `Bearer ${process.env.SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'select contract_version, manifest_sha256, migration_count from public.schema_contract_attestations order by contract_version;', read_only: true }),
    }))
    return { attestations: result }
  })
  ;[sb, anon, service] = await Promise.all(['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY'].map(renderEnv))
  const a = await account(), b = await account()
  await check('authenticated-fish-audio', async () => {
    const began = Date.now()
    const response = await api(a, '/api/tts', 'POST', { text: '这是 MyChat 隔离验收音频。中文语音和 English playback 测试结束。' })
    const firstByteMs = Date.now() - began
    ensure(response.status === 200, `TTS HTTP ${response.status}`)
    ensure(response.headers.get('content-type')?.startsWith('audio/mpeg'), 'TTS MIME mismatch')
    const bytes = Buffer.from(await response.arrayBuffer())
    ensure(bytes.length > 1000 && bytes.length < 20 * 1024 * 1024, 'TTS audio size invalid')
    writeFileSync(`${output}/tts.mp3`, bytes)
    const metadata = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_name,sample_rate,channels', '-of', 'json', `${output}/tts.mp3`], { encoding: 'utf8' }))
    execFileSync('ffmpeg', ['-v', 'error', '-i', `${output}/tts.mp3`, '-f', 'null', '-'], { stdio: ['ignore', 'ignore', 'pipe'] })
    ensure(metadata.streams?.[0]?.codec_name === 'mp3' && Number(metadata.format.duration) > 0, 'Audio decode failed')
    return { firstByteMs, totalMs: Date.now() - began, bytes: bytes.length, metadata }
  })
  await check('memory-preferences-persist-on-session-refresh', async () => {
    for (const [key, value] of [['enabled', false], ['enabled', true], ['sensitiveEnabled', true]]) {
      const saved = await json(await api(a, '/api/profile/memory', 'PUT', { [key]: value }))
      ensure(saved[key] === value, `Preference ${key} mismatch`)
    }
    const refreshed = await json(await timedFetch(`${sb}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST', headers: { apikey: anon, 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: a.refreshToken }),
    }))
    ensure(refreshed.access_token, 'Session refresh failed')
    a.token = refreshed.access_token
    const read = await json(await api(a, '/api/profile/memory'))
    ensure(read.enabled === true && read.sensitiveEnabled === true, 'Preference readback mismatch')
    const off = await json(await api(a, '/api/profile/memory', 'PUT', { sensitiveEnabled: false }))
    ensure(off.sensitiveEnabled === false, 'Sensitive opt-out mismatch')
  })
  await check('memory-crud-and-account-isolation', async () => {
    const unique = `隔离验收 ${randomUUID()}：我喜欢用铅笔写测试笔记。`
    const created = await json(await api(a, '/api/memories', 'POST', { content: unique, topic: '验收' }))
    ensure(created.memory?.id, 'Memory ID missing')
    const own = await json(await api(a, '/api/memories'))
    ensure(own.memories?.some(x => x.id === created.memory.id && x.content === unique), 'Memory missing from owner')
    const other = await json(await api(b, '/api/memories'))
    ensure(!other.memories?.some(x => x.id === created.memory.id), 'Memory leaked across accounts')
    const forbidden = await api(b, `/api/memories/${created.memory.id}`, 'DELETE')
    ensure([403, 404].includes(forbidden.status), `Cross-owner deletion HTTP ${forbidden.status}`)
    await json(await api(a, `/api/memories/${created.memory.id}`, 'DELETE'))
  })
  await check('conversation-delete-isolation-and-idempotence', async () => {
    const id = randomUUID()
    await rest('conversations', 'POST', { id, user_id: a.id, title: '隔离删除验收' })
    await rest('messages', 'POST', { id: randomUUID(), conversation_id: id, user_id: a.id, role: 'user', content: '仅删除自动创建的验收数据', seq: 1 })
    const other = await api(b, `/api/conversations/${id}`, 'DELETE')
    ensure([200, 403, 404].includes(other.status), `Cross-owner deletion HTTP ${other.status}`)
    const before = await rest(`conversations?id=eq.${id}&select=id`, 'GET')
    ensure(before.length === 1, 'Other account deleted owner conversation')
    await json(await api(a, `/api/conversations/${id}`, 'DELETE'))
    await json(await api(a, `/api/conversations/${id}`, 'DELETE'))
    const after = await rest(`conversations?id=eq.${id}&select=id`, 'GET')
    ensure(after.length === 0, 'Conversation remains after delete')
  })
} catch (error) {
  report.fatal = error.message
} finally {
  for (const id of users) {
    await check('disposable-account-cleanup', async () => {
      const response = await timedFetch(`${sb}/auth/v1/admin/users/${id}`, { method: 'DELETE', headers: adminHeaders() })
      ensure(response.ok, `Cleanup HTTP ${response.status}`)
    })
  }
  writeFileSync(`${output}/report.json`, JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
  if (report.fatal || report.checks.some(x => !x.passed)) process.exitCode = 1
}
