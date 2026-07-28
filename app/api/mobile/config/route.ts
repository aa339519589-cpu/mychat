/**
 * Native clients need the same public Supabase bootstrap values as the web
 * bundle.  The anon key is intentionally public; privileged credentials are
 * never returned here.  Keeping this behind the existing API base URL lets an
 * iOS build switch environments without embedding a Supabase project URL.
 */
export function GET(): Response {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!supabaseUrl || !supabaseAnonKey) {
    return Response.json({ error: '移动端认证配置暂不可用' }, { status: 503 })
  }
  return Response.json({ supabaseUrl, supabaseAnonKey }, {
    headers: { 'Cache-Control': 'public, max-age=300' },
  })
}
