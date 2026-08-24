import {
  exchangeMaestroAuthorizationCode,
  oauthError,
  refreshMaestroAccessToken,
} from "@/lib/maestro/oauth-server"

export async function POST(request: Request): Promise<Response> {
  const body = await request.text()
  const params = new URLSearchParams(body)
  try {
    const grantType = params.get("grant_type")
    const payload = grantType === "authorization_code"
      ? exchangeMaestroAuthorizationCode(params)
      : grantType === "refresh_token"
        ? refreshMaestroAccessToken(params)
        : null
    if (!payload) return oauthError("unsupported grant_type")
    return Response.json(payload, {
      headers: {
        "cache-control": "no-store",
        pragma: "no-cache",
      },
    })
  } catch (error) {
    return oauthError(error instanceof Error ? error.message : "token exchange failed")
  }
}
