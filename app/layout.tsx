import { Analytics } from '@vercel/analytics/next'
import type { Metadata, Viewport } from 'next'
import { Libre_Baskerville, Noto_Sans_SC } from 'next/font/google'
import './globals.css'
import 'katex/dist/katex.min.css'

const libreBaskerville = Libre_Baskerville({
  variable: '--font-spectral',
  subsets: ['latin'],
  weight: ['400', '700'],
  style: ['normal', 'italic'],
})

const notoSansSC = Noto_Sans_SC({
  variable: '--font-noto-serif-sc',
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800', '900'],
})

export const metadata: Metadata = {
  title: '简 · 文字对谈',
  description: '一个像翻阅书页、书写日记般的 AI 对谈空间',
  generator: 'v0.app',
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
    { media: '(prefers-color-scheme: light)', color: '#FDF2E2' },
    { media: '(prefers-color-scheme: dark)', color: '#1F1F1F' },
  ],
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html
      lang="zh-CN"
      className={`${libreBaskerville.variable} ${notoSansSC.variable} bg-background`}
    >
      <head>
        <link rel="preload" href="/companion.png" as="image" />
      </head>
      <body className="font-sans antialiased">
        {children}
        {process.env.NODE_ENV === 'production' && <Analytics />}
      </body>
    </html>
  )
}
