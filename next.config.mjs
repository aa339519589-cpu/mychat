/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    ignoreBuildErrors: true,
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
        source: '/',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=0, must-revalidate' }],
      },
    ]
  },
}

export default nextConfig
