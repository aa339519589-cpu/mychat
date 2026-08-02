import { Analytics } from '@vercel/analytics/next'
import type { Metadata, Viewport } from 'next'
import { headers } from 'next/headers'
import './globals.css'
import './theme-palette.css'
import './dark-background.css'
import './thinking-flow.css'
import './mobile-performance.css'
import 'katex/dist/katex.min.css'
import './math-rendering.css'

const PROVIDER_ICON_PATHS = [
  '/provider-icons/openai.svg',
  '/provider-icons/claude-color.svg',
  '/provider-icons/gemini-color.svg',
  '/provider-icons/deepseek-color.svg',
  '/provider-icons/minimax-color.svg',
  '/provider-icons/kimi.svg',
  '/provider-icons/zai.svg',
  '/provider-icons/grok.svg',
] as const

export const metadata: Metadata = {
  metadataBase: new URL('https://mychat-nm6x.onrender.com'),
  title: 'MyChat — Build and ship from your phone',
  description: 'A mobile-first AI workspace for conversation, coding, testing, GitHub delivery, and deployment without a laptop.',
  applicationName: 'MyChat',
  openGraph: {
    type: 'website',
    siteName: 'MyChat',
    title: 'MyChat — Build and ship from your phone',
    description: 'Turn your phone into the command center for coding, testing, GitHub delivery, and deployment.',
  },
  icons: {
    icon: [
      {
        url: '/icon-light-32x32.png',
        media: '(prefers-color-scheme: light)',
      },
      {
        url: '/icon-dark-32x32.png',
        media: '(prefers-color-scheme: dark)',
      },
      {
        url: '/icon.svg',
        type: 'image/svg+xml',
      },
    ],
    apple: '/apple-icon.png',
  },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  colorScheme: 'light dark',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#FFFDF8' },
    { media: '(prefers-color-scheme: dark)', color: '#222221' },
  ],
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  // Keep HTML request-bound so Next applies Proxy's nonce to framework scripts.
  await headers()
  return (
    <html lang="zh-CN" className="bg-background">
      <head>
        {PROVIDER_ICON_PATHS.map(src => (
          <link key={src} rel="preload" href={src} as="image" type="image/svg+xml" />
        ))}
      </head>
      <body className="font-sans antialiased">
        {children}
        {process.env.NODE_ENV === 'production' && <Analytics />}
      </body>
    </html>
  )
}
