"use client"

import { useEffect, useMemo, useState } from "react"
import { createPortal } from "react-dom"
import { Shapes, X, Trash2, ExternalLink, Loader2, Search } from "lucide-react"
import type { ArtifactLibraryItem } from "@/lib/artifact-data"
import { fetchArtifacts, deleteArtifactRow } from "@/lib/data"

const UI_FIX_STYLE_ID = "mychat-ui-fixes"
const UI_FIX_CSS = `
.dark [class*="dark:bg-\\[\\#151515\\]"],
.dark [role="button"][class*="bg-secondary\\/75"],
.dark div[class*="bg-secondary\\/75"]:has(textarea) {
  background-color: #2F2F2F !important;
  border-color: rgba(255, 255, 255, 0.16) !important;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.05), 0 10px 26px rgba(0, 0, 0, 0.16) !important;
}
@media (prefers-color-scheme: dark) {
  :root:not(.light) [role="button"][class*="bg-secondary\\/75"],
  :root:not(.light) div[class*="bg-secondary\\/75"]:has(textarea) {
    background-color: #2F2F2F !important;
    border-color: rgba(255, 255, 255, 0.16) !important;
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.05), 0 10px 26px rgba(0, 0, 0, 0.16) !important;
  }
}
.thinking-flow {
  display: inline-block;
  background-image: linear-gradient(90deg, rgba(86, 68, 45, 0.35), rgba(86, 68, 45, 0.95), rgba(86, 68, 45, 0.35));
  background-size: 220% 100%;
  background-position: 0% 50%;
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent !important;
  -webkit-text-fill-color: transparent;
  animation: mychat-thinking-flow 1.45s ease-in-out infinite;
}
.dark .thinking-flow {
  background-image: linear-gradient(90deg, rgba(255, 255, 255, 0.35), rgba(255, 255, 255, 0.96), rgba(255, 255, 255, 0.35));
}
@media (prefers-color-scheme: dark) {
  :root:not(.light) .thinking-flow {
    background-image: linear-gradient(90deg, rgba(255, 255, 255, 0.35), rgba(255, 255, 255, 0.96), rgba(255, 255, 255, 0.35));
  }
}
@keyframes mychat-thinking-flow {
  0% { background-position: 200% 50%; opacity: 0.55; }
  45% { opacity: 1; }
  100% { background-position: -20% 50%; opacity: 0.55; }
}
`

function patchBrandName() {
  const nodes = Array.from(document.querySelectorAll("span.font-heading.text-base.tracking-wide"))
  for (const node of nodes) {
    if (node.textContent?.trim() === "简") node.textContent = "My Chat"
  }
}

function openArtifactPreview(item: ArtifactLibraryItem) {
  const html = item.raw.trim().startsWith("<!DOCTYPE") || item.raw.trim().startsWith("<html")
    ? item.raw
    : `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>${item.title}</title></head><body>${item.raw}</body></html>`
  const url = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }))
  window.open(url, "_blank", "noopener,noreferrer")
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

export function ArtifactLibraryOverlay() {
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<ArtifactLibraryItem[]>([])
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState("")

  useEffect(() => {
    if (!document.getElementById(UI_FIX_STYLE_ID)) {
      const style = document.createElement("style")
      style.id = UI_FIX_STYLE_ID
      style.textContent = UI_FIX_CSS
      document.head.appendChild(style)
    }
  }, [])

  useEffect(() => {
    patchBrandName()
    const mo = new MutationObserver(patchBrandName)
    mo.observe(document.body, { childList: true, subtree: true })
    return () => mo.disconnect()
  }, [])

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const el = e.target as HTMLElement | null
      const button = el?.closest("button")
      if (!button) return
      const text = button.textContent?.replace(/\s+/g, "").trim()
      if (text === "作品") {
        e.preventDefault()
        e.stopPropagation()
        setOpen(true)
      }
    }
    document.addEventListener("click", onClick, true)
    return () => document.removeEventListener("click", onClick, true)
  }, [])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    fetchArtifacts()
      .then(rows => { if (!cancelled) setItems(rows) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [open])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return items
    return items.filter(item =>
      item.title.toLowerCase().includes(q) ||
      item.raw.toLowerCase().includes(q)
    )
  }, [items, query])

  async function remove(id: string) {
    setItems(prev => prev.filter(item => item.id !== id))
    await deleteArtifactRow(id)
  }

  if (!open || typeof document === "undefined") return null

  return createPortal(
    <div className="fixed inset-0 z-[90] bg-black/35 backdrop-blur-[2px]" onClick={() => setOpen(false)}>
      <aside
        onClick={e => e.stopPropagation()}
        className="absolute inset-y-0 left-0 flex w-full max-w-[24rem] flex-col overflow-hidden border-r border-sidebar-border bg-sidebar text-sidebar-foreground shadow-2xl md:left-[20rem] md:max-w-[28rem]"
      >
        <div className="flex shrink-0 items-center gap-3 px-5 pb-4 pt-[max(1rem,env(safe-area-inset-top))]">
          <button onClick={() => setOpen(false)} className="-ml-1 rounded-full p-1.5 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground" aria-label="关闭作品库">
            <X className="size-5" />
          </button>
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-[17px] font-semibold tracking-tight">作品</h3>
            <p className="text-[12px] text-muted-foreground">只保存完整 Artifact，不收现场 SVG / 公式快捷渲染</p>
          </div>
        </div>

        <div className="px-4 pb-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-sidebar-primary/70" />
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="搜索作品……"
              className="w-full rounded-xl border border-sidebar-primary/35 bg-sidebar-accent/40 py-2 pl-10 pr-3 text-[13px] outline-none placeholder:text-muted-foreground/50 transition-colors focus:border-sidebar-primary/70 focus:bg-sidebar-accent/60"
            />
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
          {loading ? (
            <div className="flex h-36 items-center justify-center text-muted-foreground">
              <Loader2 className="size-5 animate-spin" />
            </div>
          ) : filtered.length === 0 ? (
            <div className="mx-auto mt-10 flex max-w-xs flex-col items-center text-center">
              <div className="mb-4 flex size-16 items-center justify-center rounded-full bg-sidebar-accent/60 text-sidebar-primary">
                <Shapes className="size-7" />
              </div>
              <p className="font-heading text-base tracking-wide text-foreground">还没有作品</p>
              <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">只有模型输出的完整 &lt;artifact&gt; 会自动进入这里。</p>
            </div>
          ) : (
            <div className="space-y-2">
              {filtered.map(item => (
                <div key={item.id} className="group rounded-2xl border border-sidebar-accent/60 bg-sidebar-accent/35 px-4 py-3 transition-colors hover:bg-sidebar-accent/50">
                  <button onClick={() => openArtifactPreview(item)} className="block w-full text-left">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-heading text-[14px] tracking-wide text-foreground">{item.title}</p>
                        <p className="mt-1 line-clamp-2 text-[12px] leading-relaxed text-muted-foreground">{item.raw.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) || "完整 Artifact 作品"}</p>
                      </div>
                      <ExternalLink className="mt-0.5 size-4 shrink-0 text-muted-foreground/55" />
                    </div>
                    <p className="mt-2 text-[11px] text-muted-foreground">{item.date}</p>
                  </button>
                  <div className="mt-2 flex justify-end border-t border-sidebar-border/40 pt-2 opacity-0 transition-opacity group-hover:opacity-100">
                    <button onClick={() => remove(item.id)} className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-destructive" aria-label="删除作品">
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </aside>
    </div>,
    document.body,
  )
}
