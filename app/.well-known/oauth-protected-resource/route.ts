import { maestroProtectedResourceMetadata } from "@/lib/maestro/oauth"

export async function GET(request: Request): Promise<Response> {
  const origin = new URL(request.url).origin
  return Response.json(maestroProtectedResourceMetadata(origin), {
    headers: { "cache-control": "no-store" },
  })
}
