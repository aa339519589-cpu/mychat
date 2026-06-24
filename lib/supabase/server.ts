import { createServerClient } from "@supabase/ssr"
import { cookies } from "next/headers"

// 服务器端 Supabase 客户端：用于 API 路由和服务器组件，读取登录用户身份
export async function createClient() {
  const cookieStore = await cookies()

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            )
          } catch {
            // 在服务器组件中调用 setAll 会失败，可忽略（会话刷新由 proxy 处理）
          }
        },
      },
    },
  )
}
