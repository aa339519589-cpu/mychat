import { createHash } from 'node:crypto'
import type { RemoteConnector, RemoteConnectorTool } from '@/lib/mcp/remote-connectors-core'

export type CodeToolPermission = 'read' | 'write' | 'execute' | 'network' | 'publish'
export type CodeToolMetadata = {
  toolId: string
  namespace: 'builtin' | 'mcp'
  displayName: string
  description: string
  inputSchema: Record<string, unknown>
  outputSchema: Record<string, unknown>
  errorSchema: Record<string, unknown>
  schemaHash: string
  executionLocation: 'cloud-sandbox' | 'server' | 'remote-mcp'
  permissions: CodeToolPermission[]
  approvalRequired: boolean
  timeoutMs: number
  cancellationSupported: boolean
  source: string
  status: 'available' | 'needs-auth' | 'needs-approval' | 'disabled' | 'unverified' | 'unavailable'
  availabilityReason?: string
  trust: 'first-party' | 'untrusted-external'
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]),
  )
  return value
}

export function toolSchemaHash(tool: RemoteConnectorTool): string {
  return createHash('sha256').update(JSON.stringify(canonical({
    name: tool.name, inputSchema: tool.inputSchema, outputSchema: tool.outputSchema,
    annotations: tool.annotations ?? {},
  }))).digest('hex')
}

/** Provider annotations are untrusted. Only reviewed endpoints AND operations
 * may be treated as read-only without a per-invocation approval. */
export function reviewedReadOnlyTool(connector: RemoteConnector, tool: RemoteConnectorTool): boolean {
  const reviewed: Record<string, readonly string[]> = {
    'https://developers.openai.com/mcp': ['search_openai_docs', 'fetch_openai_doc', 'list_openai_docs', 'get_openapi_spec', 'list_api_endpoints'],
    'https://mcp.context7.com/mcp': ['resolve-library-id', 'query-docs', 'get-library-docs'],
  }
  return reviewed[connector.serverUrl]?.includes(tool.name) === true
    && tool.annotations?.destructiveHint !== true
    && tool.annotations?.readOnlyHint !== false
}

export function mcpToolId(connectorId: string, name: string): string {
  const suffix = createHash('sha256').update(`${connectorId}\0${name}`).digest('hex').slice(0, 16)
  return `mcp_${suffix}`
}

export function mcpToolMetadata(connector: RemoteConnector, tool: RemoteConnectorTool): CodeToolMetadata {
  const readOnly = reviewedReadOnlyTool(connector, tool)
  return {
    toolId: mcpToolId(connector.id, tool.name), namespace: 'mcp',
    displayName: `${connector.name} · ${tool.title ?? tool.name}`,
    description: tool.description ?? '', inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema ?? { type: 'object' },
    errorSchema: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' } }, required: ['code', 'message'] },
    schemaHash: toolSchemaHash(tool), executionLocation: 'remote-mcp',
    permissions: readOnly ? ['read', 'network'] : ['write', 'network'],
    approvalRequired: !readOnly, timeoutMs: 12_000, cancellationSupported: true,
    source: connector.serverUrl, status: !connector.enabled ? 'disabled' : connector.authorizationError ? 'needs-auth' : !readOnly ? 'needs-approval' : 'unverified',
    ...(!readOnly ? { availabilityReason: '外部工具需要当前任务的单次批准；未配置审批执行器时不可调用。' } : {}),
    trust: 'untrusted-external',
  }
}

const BUILTIN_WRITE = new Set(['write_files', 'edit_file', 'delete_files', 'apply_patch', 'code_remember', 'save_memory', 'update_memory', 'delete_memory'])
const BUILTIN_EXECUTE = new Set(['execute', 'verify'])
const BUILTIN_PUBLISH = new Set(['publish', 'create_repo', 'enable_pages'])

export function builtinToolPermissions(name: string): CodeToolPermission[] {
  if (BUILTIN_WRITE.has(name) || name.includes('remember')) return ['write']
  if (BUILTIN_EXECUTE.has(name)) return ['execute']
  if (BUILTIN_PUBLISH.has(name)) return ['publish']
  if (name === 'search' || name === 'fetch_url' || name === 'check_deployment') return ['read', 'network']
  return ['read']
}

export function builtinToolMetadata(tool: { function: { name: string; description: string; parameters: Record<string, unknown> } }, readiness?: {
  workspaceReady: boolean; isolatedExecutionReady: boolean
}): CodeToolMetadata {
  const { name, description, parameters } = tool.function
  const permissions = builtinToolPermissions(name)
  const isolated = permissions.includes('execute') || name === 'inspect_environment' || name === 'git_status'
  const status = !readiness ? 'unverified' : isolated
    ? readiness.isolatedExecutionReady && readiness.workspaceReady ? 'available' : 'unavailable'
    : 'unverified'
  return {
    toolId: name, namespace: 'builtin', displayName: name, description, inputSchema: parameters,
    outputSchema: { type: 'string' }, errorSchema: { type: 'string' },
    schemaHash: createHash('sha256').update(JSON.stringify(canonical(parameters))).digest('hex'),
    executionLocation: isolated ? 'cloud-sandbox' : 'server',
    permissions, approvalRequired: permissions.includes('publish') || permissions.includes('execute'),
    timeoutMs: permissions.includes('execute') ? 900_000 : 30_000,
    cancellationSupported: permissions.includes('execute') || ['search', 'fetch_url', 'inspect_environment', 'git_status'].includes(name),
    source: 'mychat/builtin', status, trust: 'first-party',
    ...(status === 'unavailable' ? { availabilityReason: '隔离云端执行环境尚未就绪或配置。' } : {}),
  }
}
