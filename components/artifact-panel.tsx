"use client"

import { useState } from "react"
import type { PointerEvent as ReactPointerEvent } from "react"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { cn } from "@/lib/utils"
import { X, Download, Copy, Check, Eye, Code2 } from "lucide-react"
import { ArtifactFrame } from "@/components/artifact-frame"
import { UI_SPRING, transitionFor } from "@/components/motion/fluid"

// 右侧 artifact 面板：预览 / 代码 切换 + 下载 + 复制 + 关闭
export function ArtifactPanel({
  raw, done, title, onClose, onDragStart,
}: {
  raw: string
  done: boolean
  title: string
  onClose: () => void
  onDragStart?: (event: ReactPointerEvent) => void
}) {
  const [tab, setTab] = useState<"preview" | "code">("preview")

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      <ArtifactToolbar raw={raw} title={title} tab={tab} onTabChange={setTab} onClose={onClose} onDragStart={onDragStart} />
      <div className="min-h-0 flex-1 overflow-hidden">
        {tab === "preview" ? (
          <div className="h-full w-full overflow-auto"><ArtifactFrame raw={raw} done={done} /></div>
        ) : (
          <div className="h-full overflow-auto bg-muted/20">
            <pre className="min-w-full p-4 text-[11px] leading-relaxed"><code className="whitespace-pre font-mono text-foreground/80">{raw}</code></pre>
          </div>
        )}
      </div>
    </div>
  )
}

function ArtifactToolbar({ raw, title, tab, onTabChange, onClose, onDragStart }: {
  raw: string
  title: string
  tab: "preview" | "code"
  onTabChange: (tab: "preview" | "code") => void
  onClose: () => void
  onDragStart?: (event: ReactPointerEvent) => void
}) {
  const [copied, setCopied] = useState(false)
  const reducedMotion = useReducedMotion()

  function copyCode() {
    navigator.clipboard.writeText(raw).catch(() => {})
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  function download() {
    const blob = new Blob([raw], { type: "text/html;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `${title || "artifact"}.html`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  return (
      <div className="fluid-material flex min-h-14 shrink-0 items-center gap-1 border-b border-border/50 px-2 py-1.5 sm:gap-2 sm:px-3">
        <span
          onPointerDown={onDragStart}
          className="min-h-11 min-w-0 flex-1 touch-none content-center truncate px-1 text-sm font-medium text-foreground md:touch-auto"
        >{title}</span>

        <div className="relative flex h-11 shrink-0 items-center rounded-lg bg-muted/60 p-0.5 text-xs">
          <button
            onClick={() => onTabChange("preview")}
            className={cn(
              "fluid-press relative flex h-10 items-center gap-1 rounded-md px-2",
              tab === "preview" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Eye className="size-3" />预览
          </button>
          <button
            onClick={() => onTabChange("code")}
            className={cn(
              "fluid-press relative flex h-10 items-center gap-1 rounded-md px-2",
              tab === "code" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Code2 className="size-3" />代码
          </button>
        </div>

        <button onClick={copyCode} title="复制代码" aria-label="复制代码" className="fluid-press fluid-icon-press flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground/60 hover:bg-muted/60 hover:text-foreground">
          <AnimatePresence initial={false} mode="popLayout">
            <motion.span
              key={copied ? "copied" : "copy"}
              initial={reducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.7 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={reducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.7 }}
              transition={transitionFor(reducedMotion, UI_SPRING)}
            >
              {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
            </motion.span>
          </AnimatePresence>
        </button>
        <button onClick={download} title="下载 HTML" aria-label="下载 HTML" className="fluid-press fluid-icon-press flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground/60 hover:bg-muted/60 hover:text-foreground">
          <Download className="size-4" />
        </button>
        <button onClick={onClose} title="关闭" aria-label="关闭作品" className="fluid-press fluid-icon-press flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground/60 hover:bg-muted/60 hover:text-foreground">
          <X className="size-4" />
        </button>
      </div>
  )
}
