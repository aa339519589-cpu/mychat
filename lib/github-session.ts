import { cookies } from "next/headers"
import { resolveAuth } from "@/lib/api/guard"

export type GitHubSession = { token: string; login: string; userId: string }

export async function getGitHubSession(): Promise<GitHubSession | null> {
  const [store, auth] = await Promise.all([cookies(), resolveAuth()])
  if (!auth.userId) return null
  const token = store.get("gh_access_token")?.value
  const boundUserId = store.get("gh_user_id")?.value
  if (!token || boundUserId !== auth.userId) return null
  const encodedLogin = store.get("gh_login")?.value ?? ""
  let login = ""
  try { login = decodeURIComponent(encodedLogin) } catch { login = "" }
  return { token, login, userId: auth.userId }
}
