"use client"

import { useEffect, useRef, useState } from "react"
import { Maximize2, Minimize2 } from "lucide-react"
import { sanitizeForPreview } from "@/lib/artifact"

// 把页面当前主题色注入 iframe，让渲染内容背景匹配页面
function injectTheme(html: string): string {
  let bg = '#ffffff', fg = '#1a1a1a'
  if (typeof document !== 'undefined') {
    const s = getComputedStyle(document.documentElement)
    const bgVal = s.getPropertyValue('--background').trim()
    const fgVal = s.getPropertyValue('--foreground').trim()
    if (bgVal) bg = `hsl(${bgVal})`
    if (fgVal) fg = `hsl(${fgVal})`
  }
  const style = `<style id="__th__">
html,body{background:${bg};color:${fg};margin:0;padding:1rem;font-family:system-ui,-apple-system,sans-serif;box-sizing:border-box;}
*,*::before,*::after{box-sizing:border-box;}
</style>`
  if (html.includes('</head>')) return html.replace('</head>', style + '</head>')
  if (html.match(/<body[^>]*>/i)) return html.replace(/(<body[^>]*>)/i, `$1${style}`)
  return style + html
}

export function ArtifactFrame({
  html,
  partialHtml,
  loading,
}: {
  html: string | null
  partialHtml: string | null
  loading: boolean
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [expanded, setExpanded] = useState(false)

  // iframe 内容完成时一次性写入，不用 srcdoc prop（避免 React 触发 iframe 重载）
  useEffect(() => {
    if (!html || !iframeRef.current) return
    iframeRef.current.srcdoc = injectTheme(html)
  }, [html])

  // ── 流式预览：用去脚本的 HTML 安全地内联渲染 ──
  if (loading) {
    const preview = sanitizeForPreview(partialHtml ?? '')
    return (
      <div className="mt-3 min-h-[2rem] overflow-hidden">
        {preview ? (
          <div
            className="text-[14px] leading-relaxed text-foreground/90"
            dangerouslySetInnerHTML={{ __html: preview }}
          />
        ) : (
          <span className="text-xs italic text-muted-foreground/50">渲染中……</span>
        )}
      </div>
    )
  }

  if (!html) return null

  // ── 完成后：沙盒 iframe，支持全屏 ──
  return (
    <div className={expanded ? 'fixed inset-4 z-50 rounded-2xl overflow-hidden shadow-2xl border border-border/30 bg-background' : 'mt-3 rounded-xl overflow-hidden'}>
      {/* 极细的操作条，hover 时才出现 */}
      <div className="group relative">
        <button
          onClick={() => setExpanded(v => !v)}
          className="absolute right-2 top-2 z-10 flex size-6 items-center justify-center rounded-full bg-background/70 text-muted-foreground opacity-0 shadow transition-opacity hover:text-foreground group-hover:opacity-100"
          aria-label={expanded ? "缩小" : "全屏"}
        >
          {expanded ? <Minimize2 className="size-3" /> : <Maximize2 className="size-3" />}
        </button>
        <iframe
          ref={iframeRef}
          sandbox="allow-scripts allow-same-origin"
          title="渲染预览"
          className="w-full border-0"
          style={{ height: expanded ? 'calc(100vh - 2rem)' : '420px', display: 'block' }}
        />
      </div>
    </div>
  )
}
