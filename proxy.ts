import { createServerClient } from "@supabase/ssr"
import { NextResponse, type NextRequest } from "next/server"

const SESSION_FREE_PATHS = new Set(["/api/live", "/api/ready", "/api/metrics"])

export async function proxy(request: NextRequest) {
  const requestId = crypto.randomUUID()
  const requestHeaders = new Headers(request.headers)
  requestHeaders.set("x-request-id", requestId)
  const nextResponse = () => NextResponse.next({ request: { headers: requestHeaders } })
  if (SESSION_FREE_PATHS.has(request.nextUrl.pathname)) {
    const response = nextResponse()
    response.headers.set("x-request-id", requestId)
    return response
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !key) {
    const response = nextResponse()
    response.headers.set("x-request-id", requestId)
    return response
  }

  let response = nextResponse()
  try {
    const supabase = createServerClient(url, key, {
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
  response.headers.set("x-request-id", requestId)
  return response
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
}
