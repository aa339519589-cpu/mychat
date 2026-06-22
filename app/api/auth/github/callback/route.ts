import { NextRequest } from 'next/server'

// 第二步：GitHub 带着 code 跳回来，换取 access_token 并写入 cookie
export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl
  const code = searchParams.get('code')
  const state = searchParams.get('state')
  const savedState = req.cookies.get('gh_oauth_state')?.value

  const home = new URL('/', req.url).toString()

  if (!code || !state || state !== savedState) {
    return Response.redirect(`${home}?github=error`)
  }

  const clientId = process.env.GITHUB_CLIENT_ID
  const clientSecret = process.env.GITHUB_CLIENT_SECRET
  if (!clientId || !clientSecret) return Response.redirect(`${home}?github=error`)

  // 用 code 换 access_token
  const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
  }).catch(() => null)

  if (!tokenRes?.ok) return Response.redirect(`${home}?github=error`)
  const tokenData = await tokenRes.json()
  const accessToken: string = tokenData.access_token
  if (!accessToken) return Response.redirect(`${home}?github=error`)

  // 拿到用户登录名
  const userRes = await fetch('https://api.github.com/user', {
    headers: { Authorization: `Bearer ${accessToken}`, 'User-Agent': 'mychat-app' },
  }).catch(() => null)
  const login: string = (await userRes?.json().catch(() => ({})))?.login ?? ''

  const cookieOpts = 'HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=7776000' // 90 天
  const headers = new Headers({ Location: `${home}?github=connected` })
  headers.append('Set-Cookie', `gh_access_token=${accessToken}; ${cookieOpts}`)
  headers.append('Set-Cookie', `gh_login=${encodeURIComponent(login)}; ${cookieOpts}`)
  headers.append('Set-Cookie', `gh_oauth_state=; HttpOnly; Path=/; Max-Age=0`) // 清掉 state cookie

  return new Response(null, { status: 302, headers })
}
