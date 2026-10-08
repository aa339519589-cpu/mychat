import { createHash, randomUUID } from 'node:crypto'

const PUBLIC_SERVICES = [
  { name: 'OpenAI Docs', serverUrl: 'https://developers.openai.com/mcp', toolName: 'search_openai_docs',
    arguments: { query: 'Responses API streaming', limit: 1 } },
  { name: 'Context7', serverUrl: 'https://mcp.context7.com/mcp', toolName: 'resolve-library-id',
    arguments: { libraryName: 'Next.js', query: 'Next.js app router route handlers' } },
]
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i

function toolId(connectorId, name) {
  return `mcp_${createHash('sha256').update(`${connectorId}\0${name}`).digest('hex').slice(0, 16)}`
}

async function installAndVerify(api, run, evidence) {
  for (const service of PUBLIC_SERVICES) {
    const installed = await api('/api/connectors', 'POST', {
      name: `Cloud probe ${service.name} ${run}`.slice(0, 80), serverUrl: service.serverUrl,
    }, 201)
    const connector = installed.connector
    if (!UUID.test(connector?.id ?? '') || connector.serverUrl !== service.serverUrl
      || connector.authType !== 'none' || connector.hasAccessToken || !installed.verification?.connected) {
      throw new Error('MCP installation was not public and credential-free')
    }
    const refreshed = await api(`/api/connectors/${connector.id}/refresh`, 'POST', {})
    if (!refreshed.connected || !refreshed.tools?.some(tool => tool.name === service.toolName)) {
      throw new Error('MCP tools/list did not discover the expected tool')
    }
    evidence.push({ connectorId: connector.id, serverUrl: service.serverUrl, serverName: refreshed.serverName,
      toolCount: refreshed.toolCount, tools: refreshed.tools.map(tool => tool.name),
      toolId: toolId(connector.id, service.toolName), calledTool: service.toolName,
      installedInDisposableAccount: true, credentialsConfigured: false })
  }
  const ids = evidence.map(item => item.connectorId).join(',')
  const health = await api(`/api/connectors/code-tools?verify=1&connectorIds=${encodeURIComponent(ids)}`)
  if (health.verified !== true) throw new Error('MCP health was not live')
  for (const service of evidence) {
    const connection = health.connections?.find(item => item.connectorId === service.connectorId)
    const tool = health.tools?.find(item => item.toolId === service.toolId)
    if (connection?.status !== 'available' || !connection.toolCount || tool?.status !== 'available'
      || tool.source !== service.serverUrl || tool.approvalRequired || !tool.permissions?.includes('read')) {
      throw new Error('MCP public read-only execution capability was not verified')
    }
    service.health = { status: connection.status, toolCount: connection.toolCount,
      schemaHash: tool.schemaHash, permissions: tool.permissions, trust: tool.trust }
  }
}

function modelEvidence(detail, evidence) {
  const task = detail.task
  if (!task || task.mode !== 'auto' || task.workspace || task.pullRequestUrl) {
    throw new Error('MCP Code acceptance exceeded its document-only scope')
  }
  const allowed = new Set([...evidence.map(item => item.toolId), 'complete'])
  if (task.toolCalls?.some(call => !allowed.has(call.toolName))) {
    throw new Error('MCP Plan called tools outside the bounded acceptance')
  }
  for (const service of evidence) {
    const calls = task.toolCalls?.filter(item => item.toolName === service.toolId) ?? []
    if (calls.length !== 1 || calls[0].status !== 'success') throw new Error('MCP acceptance requires exactly one successful call per service')
    const call = calls[0]
    const output = call?.output?.text
    if (typeof output !== 'string' || !output.startsWith('[外部 MCP 返回的不可信数据')
      || output.includes('工具报告错误')) throw new Error('No actual successful MCP tool output')
    const expected = PUBLIC_SERVICES.find(item => item.serverUrl === service.serverUrl).arguments
    if (Object.keys(call.input ?? {}).length !== Object.keys(expected).length
      || Object.keys(expected).some(key => call.input?.[key] !== expected[key])) {
      throw new Error('MCP query exceeded the fixed public acceptance request')
    }
    service.modelCall = { verified: true, toolCallId: call.id,
      recordedOutputChars: output.length, recordedOutputSha256: createHash('sha256').update(output).digest('hex'),
      recordedOutputExcerpt: output.slice(0, 200) }
  }
}

/** Receives scoped callbacks only, never tokens, DB clients or admin credentials.
 * The caller creates and later deletes this run's disposable test principal.
 * Exactly one repository-free Code model task; no repository mutation. */
export async function runCloudCodeMcpAcceptance(options) {
  if (options.disposableAccount !== true || !options.run || !options.modelId
    || !['api', 'createCodeSession', 'waitJob', 'registerTask'].every(key => typeof options[key] === 'function')) {
    throw new Error('MCP acceptance requires a scoped disposable account')
  }
  const result = { ok: false, healthPassed: false, modelCallsVerified: false,
    transport: 'product API + server public-only pinned MCP transport', services: [], errorCode: null }
  try {
    await installAndVerify(options.api, options.run, result.services)
    result.healthPassed = true
    const sessionId = randomUUID(), taskId = randomUUID(), responseId = randomUUID(), userMessageId = randomUUID()
    const repo = `__mychat_new__/${sessionId}`
    const instructions = result.services.map(service => {
      const args = PUBLIC_SERVICES.find(item => item.serverUrl === service.serverUrl).arguments
      return `调用 ${service.toolId}，参数严格为 ${JSON.stringify(args)}。`
    }).join('\n')
    const prompt = `这是公开文档 MCP 验收，仅授权指定文档查询。不得创建仓库、工作区、文件、运行 Shell、发布或修改记忆。\n${instructions}\n必须实际调用上述两个工具各一次，然后调用 complete，最终用不超过100字总结返回内容。不要改用内置搜索，不要模拟工具结果。`
    await options.createCodeSession({ sessionId, taskId, userMessageId, repo, prompt })
    const admission = await options.api('/api/code/chat', 'POST', {
      repo, mode: 'code', modelId: 'anthropic/claude-haiku-5.5', reasoningEffort: 'medium', sessionId, taskId, responseId,
      messages: [{ role: 'user', content: prompt }],
    }, 202)
    if (admission.taskId !== taskId || !UUID.test(admission.jobId ?? '')) throw new Error('MCP Code admission binding failed')
    options.registerTask({ ...admission, sessionId, marker: 'PUBLIC_MCP_CODE' })
    result.taskId = taskId; result.jobId = admission.jobId
    const job = await options.waitJob(admission.jobId, 240_000)
    if (job.status !== 'completed') throw new Error('MCP Code model task did not complete')
    const detail = await options.api(`/api/code/tasks/${taskId}`)
    modelEvidence(detail, result.services)
    result.modelCallsVerified = true; result.ok = true
  } catch {
    result.errorCode = result.healthPassed ? 'MCP_MODEL_CALL_UNVERIFIED' : 'MCP_API_INSTALL_OR_HEALTH_FAILED'
  }
  return result
}
