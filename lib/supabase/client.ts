import { createBrowserClient } from "@supabase/ssr"
import type { Database } from "./database.types"

// 浏览器端 Supabase 客户端：用于前端组件读写数据、管理登录会话
export function createClient() {
  return createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  )
}
