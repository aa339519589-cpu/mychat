import { resolveAuth } from "@/lib/api/guard"
import {
  issueMaestroAuthorizationCode,
  oauthError,
  parseMaestroAuthorizationRequest,
} from "@/lib/maestro/oauth-server"

function consentUrl(requestUrl: string, params: URLSearchParams): string {
  const url = new URL("/oauth/consent", requestUrl)
  params.forEach((value, key) => url.searchParams.set(key, value))
  return url.toString()
}

function redirectError(redirectUri: string, state: string, error: string, description: string): Response {
  const url = new URL(redirectUri)
  url.searchParams.set("error", error)
  url.searchParams.set("error_description", description)
  if (state) url.searchParams.set("state", state)
  return Response.redirect(url, 302)
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url)
  try {
    parseMaestroAuthorizationRequest(url.searchParams, url.origin)
    return Response.redirect(consentUrl(request.url, url.searchParams), 302)
  } catch (error) {
    return oauthError(error instanceof Error ? error.message : "invalid authorization request")
  }
}

export async function POST(request: Request): Promise<Response> {
  const origin = new URL(request.url).origin
  const form = await request.formData()
  const params = new URLSearchParams()
  for (const [key, value] of form.entries()) {
    if (key !== "decision" && typeof value === "string") params.append(key, value)
  }

  let parsed
  try {
    parsed = parseMaestroAuthorizationRequest(params, origin)
  } catch (error) {
    return oauthError(error instanceof Error ? error.message : "invalid authorization request")
  }

  const auth = await resolveAuth(request)
  if (auth.authUnavailable) return oauthError("authentication unavailable", 503)
  if (!auth.userId) return Response.redirect(consentUrl(request.url, params), 302)

  if (form.get("decision") === "deny") {
    return redirectError(parsed.redirectUri, parsed.state, "access_denied", "The user denied the authorization request")
  }

  const code = issueMaestroAuthorizationCode(parsed, auth.userId)
  const redirect = new URL(parsed.redirectUri)
  redirect.searchParams.set("code", code)
  if (parsed.state) redirect.searchParams.set("state", parsed.state)
  return Response.redirect(redirect, 302)
}
