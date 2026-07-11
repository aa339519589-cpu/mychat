"use client"

import { useState } from "react"
import { cn } from "@/lib/utils"
import { X, Download, Copy, Check, Eye, Code2 } from "lucide-react"
import { ArtifactFrame } from "@/components/artifact-frame"

// 右侧 artifact 面板：预览 / 代码 切换 + 下载 + 复制 + 关闭
export function ArtifactPanel({
  raw, done, title, onClose,
}: {
  raw: string
  done: boolean
  title: string
  onClose: () => void
}) {
  const [tab, setTab] = useState<"preview" | "code">("preview")
  const [copied, setCopied] = useState(false)

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
    <div className="flex h-full flex-col overflow-hidden bg-background">
      {/* 头部：标题 + tab + 操作 */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border/50 px-3 py-2.5">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{title}</span>

        <div className="flex shrink-0 items-center rounded-lg bg-muted/60 p-0.5 text-xs">
          <button
            onClick={() => setTab("preview")}
            className={cn(
              "flex items-center gap-1 rounded-md px-2 py-1 transition-colors",
              tab === "preview" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Eye className="size-3" />预览
          </button>
          <button
            onClick={() => setTab("code")}
            className={cn(
              "flex items-center gap-1 rounded-md px-2 py-1 transition-colors",
              tab === "code" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Code2 className="size-3" />代码
          </button>
        </div>

        <button onClick={copyCode} title="复制代码" className="shrink-0 rounded-lg p-1.5 text-muted-foreground/60 hover:bg-muted/60 hover:text-foreground transition-colors">
          {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
        </button>
        <button onClick={download} title="下载 HTML" className="shrink-0 rounded-lg p-1.5 text-muted-foreground/60 hover:bg-muted/60 hover:text-foreground transition-colors">
          <Download className="size-4" />
        </button>
        <button onClick={onClose} title="关闭" className="shrink-0 rounded-lg p-1.5 text-muted-foreground/60 hover:bg-muted/60 hover:text-foreground transition-colors">
          <X className="size-4" />
        </button>
      </div>

      {/* 主体 */}
      <div className="min-h-0 flex-1 overflow-hidden">
        {tab === "preview" ? (
          <div className="h-full w-full overflow-auto">
            <ArtifactFrame raw={raw} done={done} />
          </div>
        ) : (
          <div className="h-full overflow-auto bg-muted/20">
            <pre className="min-w-full p-4 text-[11px] leading-relaxed">
              <code className="whitespace-pre font-mono text-foreground/80">{raw}</code>
            </pre>
          </div>
        )}
      </div>
    </div>
  )
}
