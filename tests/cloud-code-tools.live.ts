/** Public read-only protocol acceptance probe. Never installs connectors or
 * changes global Codex configuration. Run explicitly, not in offline CI. */
import { createHash } from 'node:crypto'
import { createCodeMcpBroker } from '@/lib/code-tools/mcp-broker'
import { mcpToolId } from '@/lib/code-tools/registry'
import { discoverRemoteConnectorTools, type ConnectorFetch, type RemoteConnector } from '@/lib/mcp/remote-connectors-core'

const useSystemNetwork = process.env.MYCHAT_MCP_PROBE_SYSTEM_FETCH === '1'
// The diagnostic adapter accommodates a developer system with fake-IP DNS.
// It is used only for these two fixed public endpoints, with no credentials.
const fetchImpl: ConnectorFetch | undefined = useSystemNetwork ? (url, init) => {
  if (!['https://developers.openai.com/mcp', 'https://mcp.context7.com/mcp'].includes(String(url))) {
    throw new Error('Probe endpoint outside fixed public allowlist')
  }
  return fetch(url, { ...init, redirect: 'error' })
} : undefined

async function main() {
  for (const [index, probe] of [
    { serverUrl: 'https://developers.openai.com/mcp', toolName: 'search_openai_docs', args: { query: 'Responses API streaming', limit: 1 } },
    { serverUrl: 'https://mcp.context7.com/mcp', toolName: 'resolve-library-id', args: { libraryName: 'Next.js', query: 'Next.js app router route handlers' } },
  ].entries()) {
    const discovered = await discoverRemoteConnectorTools({ serverUrl: probe.serverUrl, accessToken: null }, undefined, fetchImpl)
    const connector: RemoteConnector = {
      id: `00000000-0000-4000-8000-00000000000${index}`, userId: 'probe-only', name: discovered.serverName ?? 'public-docs',
      ...probe, accessToken: null, enabled: true, tools: discovered.tools,
    }
    const broker = await createCodeMcpBroker({ userId: connector.userId, mode: 'plan', loadConnectors: async () => [connector], fetchImpl })
    const output = await broker.execute(mcpToolId(connector.id, probe.toolName), probe.args)
    const ok = output.startsWith('[外部 MCP') && !output.includes('工具报告错误')
    console.log(JSON.stringify({
      serverUrl: probe.serverUrl, serverName: discovered.serverName,
      transport: useSystemNetwork ? 'SDK + system fetch (diagnostic only)' : 'SDK + production public-only transport',
      installedInUserAccount: false, toolCount: discovered.tools.length,
      tools: discovered.tools.map(tool => tool.name), calledTool: probe.toolName,
      ok, outputChars: output.length, outputSha256: createHash('sha256').update(output).digest('hex'),
      excerpt: output.slice(0, 350),
    }))
    if (!ok) process.exitCode = 1
  }
}
void main().catch(error => { console.error(String(error)); process.exitCode = 1 })
