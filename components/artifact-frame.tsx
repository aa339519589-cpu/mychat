"use client"

import { useEffect, useRef, useState } from "react"
import { Loader2, Maximize2, Minimize2 } from "lucide-react"

export function ArtifactFrame({ html, loading }: { html: string | null; loading: boolean }) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    if (!html || !iframeRef.current) return
    // 直接写 srcdoc 绕过 React 的 diff，避免 iframe 重载
    iframeRef.current.srcdoc = html
  }, [html])

  if (loading) {
    return (
      <div className="mt-4 flex h-20 items-center justify-center gap-2 rounded-2xl border border-border/40 bg-muted/20 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        <span className="italic">渲染中……</span>
      </div>
    )
  }

  if (!html) return null

  return (
    <div className={`mt-4 overflow-hidden rounded-2xl border border-border/40 bg-white transition-all duration-200 ${expanded ? "fixed inset-4 z-50 shadow-2xl" : "relative"}`}>
      <div className="flex items-center justify-between border-b border-border/30 bg-muted/30 px-3 py-1.5">
        <span className="text-[11px] text-muted-foreground/70 italic">渲染预览</span>
        <button
          onClick={() => setExpanded(v => !v)}
          className="rounded p-1 text-muted-foreground/60 hover:bg-muted/60 hover:text-muted-foreground transition-colors"
          aria-label={expanded ? "缩小" : "全屏"}
        >
          {expanded ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
        </button>
      </div>
      <iframe
        ref={iframeRef}
        sandbox="allow-scripts allow-same-origin"
        title="渲染预览"
        className="w-full border-0 bg-white"
        style={{ height: expanded ? "calc(100vh - 7rem)" : "420px" }}
      />
    </div>
  )
}
