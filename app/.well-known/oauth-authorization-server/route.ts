import { maestroOAuthAuthorizationServerMetadata } from "@/lib/maestro/oauth-server"

export async function GET(request: Request): Promise<Response> {
  const origin = new URL(request.url).origin
  return Response.json(maestroOAuthAuthorizationServerMetadata(origin), {
    headers: { "cache-control": "no-store" },
  })
}
