"use client"

import { useEffect, useState } from "react"
import type { User } from "@supabase/supabase-js"
import { createClient } from "@/lib/supabase/client"

export function useAuthUser() {
  const [user, setUser] = useState<User | null>(null)
  const [authChecked, setAuthChecked] = useState(false)
  const [authError, setAuthError] = useState<string | null>(null)

  useEffect(() => {
    let supabase
    try {
      supabase = createClient()
    } catch {
      setAuthError("当前本地服务没有配置 Supabase，无法加载账户数据。")
      setAuthChecked(true)
      return undefined
    }
    supabase.auth.getUser().then(({ data }) => {
      setUser(data.user)
      setAuthChecked(true)
    }).catch(() => {
      setAuthError("无法连接 Supabase，暂时不能加载账户数据。")
      setAuthChecked(true)
    })
    const { data: subscription } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null)
      setAuthChecked(true)
    })
    return () => subscription.subscription.unsubscribe()
  }, [])

  return { user, setUser, authChecked, authError }
}
