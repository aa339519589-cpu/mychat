// 断开 GitHub 连接：清除 access_token cookie
export async function POST() {
  const clear = 'HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0'
  const headers = new Headers({ 'Content-Type': 'application/json' })
  headers.append('Set-Cookie', `gh_access_token=; ${clear}`)
  headers.append('Set-Cookie', `gh_login=; ${clear}`)
  return new Response(JSON.stringify({ ok: true }), { headers })
}
