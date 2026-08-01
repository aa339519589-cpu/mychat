import { Analytics } from '@vercel/analytics/next'
import type { Metadata, Viewport } from 'next'
import { headers } from 'next/headers'
import './globals.css'
import './theme-palette.css'
import './dark-background.css'
import './thinking-flow.css'
import './mobile-performance.css'
import 'katex/dist/katex.min.css'

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
      <body className="font-sans antialiased">
        {children}
        {process.env.NODE_ENV === 'production' && <Analytics />}
      </body>
    </html>
  )
}
