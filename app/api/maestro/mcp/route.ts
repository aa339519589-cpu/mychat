import { NextRequest } from "next/server"
import { handleMaestroRpc } from "@/lib/maestro/mcp"
import { createAdminClient } from "@/lib/supabase/admin"
import { createMaestroTask, MAESTRO_BRANCH, publicMaestroTask } from "@/lib/maestro/store"
import { MAESTRO_WIDGET_URI } from "@/lib/maestro/widget"

const MAX_BODY_BYTES = 512 * 1024
const MAX_OBJECTIVE = 100_000
const DEFAULT_MAX_ROUNDS = 10_000

type RpcResponse = Awaited<ReturnType<typeof handleMaestroRpc>>
type JsonRpcId = string | number | null

type RpcEnvelope = {
  jsonrpc?: unknown
  id?: JsonRpcId
  method?: unknown
  params?: unknown
}

const MAESTRO_CREATE_TOOL = {
  name: "maestro_create_task",
  title: "Create and start Maestro Runner",
  description: "Create a new My Chat Maestro Runner task from the user's objective, generate its start code automatically, mount the Maestro Runner UI, and begin automatic cross-turn execution. Use this when the user asks My che che. to do a new long-running task and has not supplied a start code. Do not ask the user for a start code first.",
  inputSchema: {
    type: "object",
    properties: {
      objective: {
        type: "string",
        minLength: 1,
        maxLength: MAX_OBJECTIVE,
        description: "The complete task objective to execute across Maestro turns.",
      },
      maxRounds: {
        type: "integer",
        minimum: 2,
        maximum: 100_000,
        default: DEFAULT_MAX_ROUNDS,
        description: "Maximum automatic worker/review turns. Defaults to 10000.",
      },
    },
    required: ["objective"],
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false,
    idempotentHint: false,
  },
  _meta: {
    ui: { resourceUri: MAESTRO_WIDGET_URI, visibility: ["model", "app"] },
    "openai/outputTemplate": MAESTRO_WIDGET_URI,
    "openai/toolInvocation/invoking": "Creating Maestro task…",
    "openai/toolInvocation/invoked": "Maestro task created",
  },
} as const

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  })
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function toolError(id: JsonRpcId, message: string): NonNullable<RpcResponse> {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      isError: true,
      content: [{ type: "text", text: message }],
    },
  }
}

async function body(request: NextRequest): Promise<unknown> {
  const length = Number(request.headers.get("content-length") ?? "0")
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) throw new Error("too_large")
  const raw = await request.text()
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) throw new Error("too_large")
  return raw ? JSON.parse(raw) : null
}

async function resolveMaestroOwnerUserId(): Promise<string> {
  const configured = process.env.MAESTRO_OWNER_USER_ID?.trim()
  if (configured) return configured

  const admin = createAdminClient()
  if (!admin) throw new Error("Maestro storage is unavailable")

  const latestMaestro = await admin.from("agent_tasks")
    .select("user_id")
    .eq("branch", MAESTRO_BRANCH)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (latestMaestro.error) throw new Error(latestMaestro.error.message)
  if (latestMaestro.data?.user_id) return latestMaestro.data.user_id

  const latestTask = await admin.from("agent_tasks")
    .select("user_id")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (latestTask.error) throw new Error(latestTask.error.message)
  if (latestTask.data?.user_id) return latestTask.data.user_id

  const users = await admin.auth.admin.listUsers({ page: 1, perPage: 2 })
  if (users.error) throw new Error(users.error.message)
  if (users.data.users.length === 1) return users.data.users[0].id

  throw new Error("Unable to resolve the Maestro owner. Set MAESTRO_OWNER_USER_ID once on the server.")
}

async function createAndStartMaestro(rpc: RpcEnvelope, origin: string): Promise<RpcResponse> {
  const id = rpc.id ?? null
  const params = record(rpc.params)
  const args = record(params?.arguments)
  const objective = typeof args?.objective === "string" ? args.objective.trim() : ""
  const rawMaxRounds = args?.maxRounds === undefined ? DEFAULT_MAX_ROUNDS : Number(args.maxRounds)

  if (!objective || objective.length > MAX_OBJECTIVE) {
    return toolError(id, `objective must contain 1 to ${MAX_OBJECTIVE} characters`)
  }
  if (!Number.isSafeInteger(rawMaxRounds) || rawMaxRounds < 2 || rawMaxRounds > 100_000) {
    return toolError(id, "maxRounds must be an integer from 2 to 100000")
  }

  try {
    const admin = createAdminClient()
    if (!admin) throw new Error("Maestro storage is unavailable")
    const userId = await resolveMaestroOwnerUserId()
    const row = await createMaestroTask(admin, userId, objective, rawMaxRounds)
    const task = publicMaestroTask(row)
    if (!task) throw new Error("Maestro task metadata is invalid")

    return handleMaestroRpc({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: {
        name: "maestro_start",
        arguments: { startCode: task.startCode },
      },
    }, { origin })
  } catch (error) {
    return toolError(id, error instanceof Error ? error.message : "Maestro task creation failed")
  }
}

function augmentResponse(rpc: RpcEnvelope, response: RpcResponse): RpcResponse {
  if (!response || !response.result || typeof response.result !== "object" || Array.isArray(response.result)) return response

  if (rpc.method === "tools/list") {
    const result = response.result as { tools?: unknown[] }
    if (Array.isArray(result.tools) && !result.tools.some(tool => record(tool)?.name === MAESTRO_CREATE_TOOL.name)) {
      result.tools = [MAESTRO_CREATE_TOOL, ...result.tools]
    }
  }

  if (rpc.method === "initialize") {
    const result = response.result as { instructions?: unknown }
    const current = typeof result.instructions === "string" ? result.instructions : ""
    result.instructions = [
      "Maestro Runner is a cross-turn orchestrator.",
      "For a NEW task, call maestro_create_task directly with the user's objective. It creates the task, generates the start code internally, mounts the Runner UI, and starts the first worker turn. Never ask the user to provide a start code for a new task.",
      "Use maestro_start only when the user already supplied an existing start code.",
      "During an active job, every worker/review turn must end with maestro_round_gate. The UI posts the next ChatGPT message automatically until a separate review turn reaches finish.",
      current,
    ].filter(Boolean).join(" ")
  }

  return response
}

async function handleOne(value: unknown, origin: string): Promise<RpcResponse> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } }
  }

  const rpc = value as RpcEnvelope
  if (rpc.method === "tools/call") {
    const params = record(rpc.params)
    if (params?.name === MAESTRO_CREATE_TOOL.name) return createAndStartMaestro(rpc, origin)
  }

  const response = await handleMaestroRpc(rpc, { origin })
  return augmentResponse(rpc, response)
}

export async function POST(request: NextRequest): Promise<Response> {
  let value: unknown
  try { value = await body(request) }
  catch (error) {
    const tooLarge = error instanceof Error && error.message === "too_large"
    return json({ jsonrpc: "2.0", id: null, error: { code: tooLarge ? -32600 : -32700, message: tooLarge ? "Request too large" : "Parse error" } }, tooLarge ? 413 : 400)
  }

  const origin = new URL(request.url).origin
  if (Array.isArray(value)) {
    if (value.length === 0) return json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } }, 400)
    const responses = (await Promise.all(value.map(item => handleOne(item, origin)))).filter((item): item is Exclude<RpcResponse, null> => item !== null)
    return responses.length ? json(responses) : new Response(null, { status: 202 })
  }
  const response = await handleOne(value, origin)
  return response ? json(response) : new Response(null, { status: 202 })
}

export async function GET(): Promise<Response> {
  return new Response(null, { status: 405, headers: { allow: "POST, OPTIONS", "cache-control": "no-store" } })
}

export async function OPTIONS(): Promise<Response> {
  return new Response(null, {
    status: 204,
    headers: {
      allow: "POST, OPTIONS",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type, accept, mcp-protocol-version, mcp-session-id",
      "access-control-max-age": "86400",
    },
  })
}
