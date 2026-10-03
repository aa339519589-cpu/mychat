export const MAX_CONNECTOR_TOOLS = 80
export const MAX_TOOLS_PER_CONNECTOR = 24
export const MAX_CONNECTOR_RESULT_CHARS = 24_000
export const MAX_AUTO_CONNECTOR_TOOLS = 12
export const MAX_ON_DEMAND_CONNECTOR_RESULTS = 8
export const MCP_APPS_EXTENSION_ID = 'io.modelcontextprotocol/ui'
export const MCP_APPS_RESOURCE_MIME = 'text/html;profile=mcp-app'
export const MAX_CONNECTOR_APP_HTML_BYTES = 512 * 1024
export const MAX_CONNECTOR_APP_CALL_BYTES = 160 * 1024

export class RemoteConnectorError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message)
    this.name = 'RemoteConnectorError'
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
