import {
  callMaestroV4Begin,
  callMaestroV4Create,
  callMaestroV4Gate,
  callMaestroV4Sync,
} from "@/lib/maestro/v4-engine"
import { MAESTRO_V4_TOOLS } from "@/lib/maestro/v4-tools"
import { MAESTRO_V4_WIDGET_HTML, MAESTRO_V4_WIDGET_URI } from "@/lib/maestro/widget-v4"

export { MAESTRO_V4_TOOLS } from "@/lib/maestro/v4-tools"
export { evaluateMaestroV4Gate } from "@/lib/maestro/v4-engine"

export const MAESTRO_V4_PROTOCOL_VERSION = "2025-06-18"
export const MAESTRO_V4_SERVER_NAME = "mychat-maestro-runner-v4-zero-code"
export const MAESTRO_V4_SERVER_VERSION = "4.1.0"

export type MaestroV4RpcOptions = { origin: string; userId?: string | null }
type JsonRpcId = string | number | null
type JsonRpcResponse = { jsonrpc: "2.0"; id: JsonRpcId; result?: unknown; error?: { code: number; message: string } }

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function rpcError(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } }
}

function requireUser(options: MaestroV4RpcOptions): string {
  const userId = options.userId?.trim()
  if (!userId) throw new Error("Maestro requires an authenticated My Chat user. Reconnect this app with OAuth.")
  return userId
}

function resource() {
  return {
    uri: MAESTRO_V4_WIDGET_URI,
    mimeType: "text/html;profile=mcp-app",
    text: MAESTRO_V4_WIDGET_HTML,
    _meta: {
      ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } },
      "openai/widgetDescription": "Maestro Runner v4: zero-code automatic cross-turn continuation with immutable completion criteria.",
      "openai/widgetPrefersBorder": true,
      "openai/widgetCSP": { connect_domains: [], resource_domains: [] },
    },
  }
}

export async function handleMaestroV4Rpc(value: unknown, options: MaestroV4RpcOptions): Promise<JsonRpcResponse | null> {
  const body = record(value)
  const id = (typeof body?.id === "string" || typeof body?.id === "number" || body?.id === null) ? body.id as JsonRpcId : null
  if (!body || body.jsonrpc !== "2.0" || typeof body.method !== "string") return rpcError(id, -32600, "Invalid Request")
  if (body.method.startsWith("notifications/")) return null

  if (body.method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: MAESTRO_V4_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: true }, resources: { listChanged: true } },
        serverInfo: { name: MAESTRO_V4_SERVER_NAME, version: MAESTRO_V4_SERVER_VERSION },
        instructions: "For a new task created inside ChatGPT call maestro_create_task. For a task launched from My Chat call maestro_begin with an empty object, then end the current turn; the attached Runner starts the first worker turn. Never ask the user for a start code, token, task id, or relay value. Objective, successCriterion, and hardRules are immutable. Work never finishes. Only a separate independent review may finish after strictly verifying the exact success criterion with non-empty reviewEvidence. Runtime/tool/time/token/round limits, inability, lack of progress, or unknown methods never count as completion. Every worker/review turn ends with maestro_round_gate; the Runner synchronizes later turns with app-only maestro_sync.",
      },
    }
  }

  if (body.method === "ping") return { jsonrpc: "2.0", id, result: {} }
  if (body.method === "tools/list") {
    console.log(`[maestro-v4] tools/list ${MAESTRO_V4_SERVER_NAME}@${MAESTRO_V4_SERVER_VERSION}: ${MAESTRO_V4_TOOLS.map(tool => tool.name).join(",")}`)
    return { jsonrpc: "2.0", id, result: { tools: MAESTRO_V4_TOOLS } }
  }
  if (body.method === "resources/list") {
    return { jsonrpc: "2.0", id, result: { resources: [{ uri: MAESTRO_V4_WIDGET_URI, name: "Maestro Runner v4", mimeType: "text/html;profile=mcp-app" }] } }
  }
  if (body.method === "resources/templates/list") return { jsonrpc: "2.0", id, result: { resourceTemplates: [] } }
  if (body.method === "resources/read") {
    const params = record(body.params)
    if (params?.uri !== MAESTRO_V4_WIDGET_URI) return rpcError(id, -32002, "Resource not found")
    return { jsonrpc: "2.0", id, result: { contents: [resource()] } }
  }

  if (body.method === "tools/call") {
    const params = record(body.params)
    try {
      const userId = requireUser(options)
      if (params?.name === "maestro_create_task") return { jsonrpc: "2.0", id, result: await callMaestroV4Create(params.arguments, userId) }
      if (params?.name === "maestro_begin") return { jsonrpc: "2.0", id, result: await callMaestroV4Begin(userId) }
      if (params?.name === "maestro_round_gate") return { jsonrpc: "2.0", id, result: await callMaestroV4Gate(params.arguments, userId) }
      if (params?.name === "maestro_sync") return { jsonrpc: "2.0", id, result: await callMaestroV4Sync(params.arguments, userId) }
      return rpcError(id, -32602, "Unknown Maestro v4 tool")
    } catch (error) {
      return {
        jsonrpc: "2.0",
        id,
        result: { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "Maestro v4 tool failed" }] },
      }
    }
  }

  return rpcError(id, -32601, "Method not found")
}
