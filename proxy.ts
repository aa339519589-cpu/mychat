import { createServerClient } from "@supabase/ssr"
import { NextResponse, type NextRequest } from "next/server"
import type { Database } from "@/lib/supabase/database.types"
import {
  contentSecurityPolicy,
  createContentSecurityPolicyNonce,
} from "@/lib/content-security-policy"

const SESSION_FREE_PATHS = new Set(["/api/live", "/api/ready", "/api/metrics"])

export async function proxy(request: NextRequest) {
  const requestId = crypto.randomUUID()
  const nonce = createContentSecurityPolicyNonce()
  const policy = contentSecurityPolicy(nonce, process.env.NODE_ENV === "production")
  const requestHeaders = new Headers(request.headers)
  requestHeaders.set("x-request-id", requestId)
  requestHeaders.set("x-nonce", nonce)
  requestHeaders.set("content-security-policy", policy)
  const nextResponse = () => {
    const response = NextResponse.next({ request: { headers: requestHeaders } })
    response.headers.set("content-security-policy", policy)
    response.headers.set("x-request-id", requestId)
    if (!request.nextUrl.pathname.startsWith("/api/")) {
      response.headers.set("cache-control", "private, no-store")
    }
    return response
  }
  if (SESSION_FREE_PATHS.has(request.nextUrl.pathname)) {
    return nextResponse()
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !key) {
    return nextResponse()
  }

  let response = nextResponse()
  try {
    const supabase = createServerClient<Database>(url, key, {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll(cookies) {
          cookies.forEach(({ name, value }) => request.cookies.set(name, value))
          response = nextResponse()
          cookies.forEach(({ name, value, options }) => response.cookies.set(name, value, options))
        },
      },
    })
    await supabase.auth.getUser()
  } catch {
    response = nextResponse()
  }
  return response
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
}
