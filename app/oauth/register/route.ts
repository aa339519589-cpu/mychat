import { oauthError, registerMaestroOAuthClient } from "@/lib/maestro/oauth-server"

export async function POST(request: Request): Promise<Response> {
  try {
    const body = await request.json()
    return Response.json(registerMaestroOAuthClient(body), {
      status: 201,
      headers: { "cache-control": "no-store" },
    })
  } catch (error) {
    return oauthError(error instanceof Error ? error.message : "client registration failed")
  }
}
