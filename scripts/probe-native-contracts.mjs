import { randomUUID, randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const origin = 'https://mychat-nm6x.onrender.com'
const report = { observedAt: new Date().toISOString(), phase: 'after-release', checks: [] }
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
    for (let attempt = 0; attempt < 12; attempt++) {
      const response = await timedFetch(`${origin}/api/ready`)
      report.readiness = await response.json()
      if (response.ok && report.readiness.revision === '1cdd39f24e8e') return { warmupAttempts: attempt + 1 }
      await new Promise(resolve => setTimeout(resolve, 5000))
    }
    ensure(false, 'Expected production revision is not ready')
  })
  ;[sb, anon, service] = await Promise.all(['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY'].map(renderEnv))
  await check('production-schema-v10-and-v5-rollback', async () => {
    for (const [version,digest,count] of [[10,'b8c2500aee3ef8059d6119387b9e08106175f407488a003ec982103964739a35',61],[5,'69e4973cfac2b9532f27b784257df991e09796c1bdf8a6872297806de0db4d74',51]]) {
      const ok = await rest('rpc/verify_schema_contract_v3','POST',{input_contract_version:version,input_manifest_sha256:digest,input_migration_count:count})
      ensure(ok === true, `Contract v${version} did not verify`)
    }
  })
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

  await check('conversation-media-cleanup', async () => {
    const id = randomUUID(), generation = randomUUID(), key = `${a.id}/${id}/${generation}/audit.png`
    await rest('conversations','POST',{id,user_id:a.id,title:'媒体清理隔离验收'})
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64')
    const uploaded = await timedFetch(`${sb}/storage/v1/object/generated-media/${key}`,{method:'POST',headers:{...adminHeaders(),'Content-Type':'image/png'},body:png})
    ensure(uploaded.ok, `Media upload HTTP ${uploaded.status}`)
    await rest('messages','POST',{id:randomUUID(),conversation_id:id,user_id:a.id,role:'assistant',content:'媒体清理验收',seq:1,
      images:{generated_media:[{type:'image',url:`/api/v1/media/${key}/content`,mimeType:'image/png'}]}})
    const deletion = await json(await api(a,`/api/conversations/${id}`,'DELETE'))
    const listed = await json(await timedFetch(`${sb}/storage/v1/object/list/generated-media`,{method:'POST',headers:adminHeaders(),body:JSON.stringify({prefix:`${a.id}/${id}/${generation}`,limit:10})}))
    ensure(!listed.some(x=>x.name==='audit.png'),'Media remains after conversation deletion')
    return {cleanupPending:deletion.cleanupPending ?? false}
  })
  await check('official-connector-directory',async()=>{
    const directory=await json(await api(a,'/api/connectors/directory?search=microsoft'))
    ensure(Array.isArray(directory.entries),'Directory entries missing')
    return {entries:directory.entries.length,source:directory.source}
  })
  const models=await json(await api(a,'/api/models'))
  const model=models.models.find(x=>x.access==='quota' && x.tools && x.outputKind==='chat')
  ensure(model,'No configured base tool-capable model')
  report.model=model.id
  async function chat(user,prompt,options={}) {
    const conversationId=randomUUID(), generationId=randomUUID(), userMessageId=randomUUID(), assistantMessageId=randomUUID()
    const request={modelId:model.id,messages:[{id:userMessageId,role:'user',content:prompt,ts:new Date().toISOString()}],
      searchMode:'off',historyRetrieval:false,connectorIds:options.connectorIds ?? [],connectorAccessMode:'always_available',renderEnabled:false,
      conversationId,generationId,userMessageId,assistantMessageId,
      turn:{schemaVersion:1,createConversation:true,title:'隔离模型验收',projectId:options.projectId ?? null,memoryEnabled:options.memoryEnabled ?? true}}
    if (model.reasoningEfforts?.includes('none')) request.reasoningEffort='none'
    const admitted=await json(await api(user,'/api/chat','POST',request))
    ensure(admitted.jobId===generationId,'Admission identity mismatch')
    if(options.testActiveDelete) {
      const deletion=await api(user,`/api/conversations/${conversationId}`,'DELETE')
      ensure(deletion.status===409,`Active deletion HTTP ${deletion.status}`)
    }
    let job
    for(let i=0;i<70;i++) {
      job=(await json(await api(user,`/api/v1/jobs/${generationId}`))).job
      if(['succeeded','failed','cancelled','dead_letter'].includes(job.status))break
      await new Promise(resolve=>setTimeout(resolve,2000))
    }
    ensure(job?.status==='succeeded',`Model job ${job?.status}/${job?.errorCode}`)
    const messages=await rest(`messages?id=eq.${assistantMessageId}&select=content`,'GET')
    const events=await rest(`job_events?job_id=eq.${generationId}&select=kind,payload&order=seq.asc`,'GET')
    return {text:messages[0]?.content ?? '',events,conversationId,generationId}
  }
  const globalMarker=`枫叶${randomBytes(5).toString('hex')}`
  await check('model-reads-global-memory-and-active-delete-conflicts',async()=>{
    await json(await api(a,'/api/memories','POST',{content:`我的验收偏好图形是${globalMarker}。`,topic:'验收偏好'}))
    const result=await chat(a,'从已保存的记忆中找出我的验收偏好图形，原样回答名称。先列出三个验证步骤，然后回答。',{testActiveDelete:true})
    ensure(result.text.includes(globalMarker),'Model did not read the saved memory')
    return {model:model.id,activeDeleteStatus:409,outputCharacters:result.text.length}
  })
  await check('model-writes-memory-through-tool',async()=>{
    const marker=`蓝杉${randomBytes(5).toString('hex')}`
    const result=await chat(a,`请使用记忆工具记住：我喜欢的验收笔记本名称是${marker}。这是普通物品偏好，不是秘密。保存后简短确认。`)
    const list=await json(await api(a,'/api/memories'))
    ensure(list.memories.some(x=>x.content.includes(marker)),'Model did not persist requested memory')
    ensure(result.events.some(x=>x.kind==='tool.memory' && x.payload?.memory?.ok),'No successful memory tool event')
    return {memoryToolEvent:true}
  })
  await check('model-memory-account-and-chat-isolation',async()=>{
    const noMemory=await chat(a,'我的验收偏好图形是什么？仅依据你已有的上下文，不知道就说不知道。',{memoryEnabled:false})
    const other=await chat(b,'我的验收偏好图形是什么？仅依据你已有的上下文，不知道就说不知道。')
    ensure(!noMemory.text.includes(globalMarker),'Conversation memory control leaked saved memory')
    ensure(!other.text.includes(globalMarker),'Model memory leaked across accounts')
  })
  await check('model-project-memory-isolation',async()=>{
    const first=randomUUID(),second=randomUUID(), marker=`青竹${randomBytes(5).toString('hex')}`
    await rest('projects','POST',[{id:first,user_id:a.id,name:'隔离项目甲'},{id:second,user_id:a.id,name:'隔离项目乙'}])
    await rest('project_memories','POST',{user_id:a.id,project_id:first,content:`本项目的验收偏好图形是${marker}。`,topic:'验收'})
    const own=await chat(a,'本项目的验收偏好图形是什么？只回答名称。',{projectId:first})
    const unrelated=await chat(a,'本项目的验收偏好图形是什么？不知道就说不知道。',{projectId:second})
    ensure(own.text.includes(marker),'Model did not read its project memory')
    ensure(!own.text.includes(globalMarker),'Global memory leaked into project context')
    ensure(!unrelated.text.includes(marker) && !unrelated.text.includes(globalMarker),'Unrelated memory leaked into another project')
  })
  await check('real-mcp-discovery-and-model-tool-call',async()=>{
    const created=await json(await api(a,'/api/connectors','POST',{name:'Microsoft Learn 验收',serverUrl:'https://learn.microsoft.com/api/mcp'}))
    const connector=created.connector
    ensure(connector?.id && connector.tools.some(x=>x.name==='microsoft_docs_search'),'Official MCP tool discovery failed')
    const other=await json(await api(b,'/api/connectors'))
    ensure(!other.connectors.some(x=>x.id===connector.id),'Connector leaked across accounts')
    const result=await chat(a,'请调用 Microsoft Learn 连接器的 microsoft_docs_search 搜索 Azure Functions overview，给出官方文档链接和一句介绍。必须实际调用该工具。',{connectorIds:[connector.id],memoryEnabled:false})
    const calls=result.events.filter(x=>x.kind==='tool.completed' && /mcp_/.test(x.payload?.toolName ?? ''))
    ensure(calls.length>0 && result.text.includes('learn.microsoft.com'),'No successful actual connector call with source')
    await json(await api(a,`/api/connectors/${connector.id}`,'DELETE'))
    return {discoveredTools:connector.toolCount,completedCalls:calls.length}
  })
  await check('private-chat-route-and-no-history',async()=>{
    const privateID=randomUUID()
    const response=await api(a,'/api/chat/private','POST',{modelId:model.id,conversationId:privateID,
      messages:[{role:'user',content:'请简短回答：你好',ts:new Date().toISOString()}],searchMode:'off',historyRetrieval:false,renderEnabled:false})
    ensure(response.status===200,`Private chat HTTP ${response.status}`)
    const stream=await response.text()
    ensure(stream.includes('text.delta'),'Private stream did not emit text')
    const stored=await rest(`conversations?id=eq.${privateID}&select=id`,'GET')
    ensure(stored.length===0,'Private conversation persisted to history')
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
