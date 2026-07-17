const contentSecurityPolicy = [
  "default-src 'self'",
  // function-plot compiles user-entered math expressions at runtime with
  // Function/eval. This explicit exception is required in production or the
  // browser blocks function graph rendering. Script origins remain self-only.
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "media-src 'self' blob: https:",
  "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://vitals.vercel-insights.com",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  'upgrade-insecure-requests',
].join('; ')

const securityHeaders = [
  { key: 'Content-Security-Policy', value: contentSecurityPolicy },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
]

/** @type {import('next').NextConfig} */
const nextConfig = {
  turbopack: {
    root: import.meta.dirname,
  },
  outputFileTracingRoot: import.meta.dirname,
  // Workspace routes read tenant files from /tmp at runtime. NFT cannot infer that
  // dynamic boundary and otherwise pulls build metadata into every API trace.
  outputFileTracingExcludes: {
    '/api/*': ['./next.config.mjs', './package-lock.json'],
  },
  images: {
    unoptimized: true,
  },
  // 首页 HTML 默认被打了 s-maxage=31536000（一年 CDN 缓存），导致每次部署后
  // 用户仍看到旧页面（引用旧 chunk）。强制 HTML 每次重新验证；带 hash 的
  // /_next/static 资源不受影响，仍可长期缓存。
  async headers() {
    return [
      {
        source: '/:path*',
        headers: securityHeaders,
      },
      {
        source: '/',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=0, must-revalidate' }],
      },
    ]
  },
}

export default nextConfig
