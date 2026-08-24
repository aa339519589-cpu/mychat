const HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
} as const

export async function POST(): Promise<Response> {
  return new Response(JSON.stringify({
    error: "gone",
    message: "Maestro state is persisted only through authenticated MCP round gates.",
  }), { status: 410, headers: HEADERS })
}

export async function OPTIONS(): Promise<Response> {
  return new Response(null, {
    status: 204,
    headers: {
      "cache-control": "no-store",
      allow: "POST, OPTIONS",
    },
  })
}
