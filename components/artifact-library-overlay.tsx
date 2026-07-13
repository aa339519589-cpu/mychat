"use client"

import { useEffect, useMemo, useState } from "react"
import { createPortal } from "react-dom"
import { Shapes, X, Trash2, ExternalLink, Loader2, Search } from "lucide-react"
import type { ArtifactLibraryItem } from "@/lib/artifact-data"
import { fetchArtifacts, deleteArtifactRow } from "@/lib/data"

function openArtifactPreview(item: ArtifactLibraryItem) {
  const html = item.raw.trim().startsWith("<!DOCTYPE") || item.raw.trim().startsWith("<html")
    ? item.raw
    : `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>${item.title}</title></head><body>${item.raw}</body></html>`
  const url = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }))
  window.open(url, "_blank", "noopener,noreferrer")
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

export type ArtifactLibraryOverlayProps = {
  open: boolean
  onClose: () => void
}

export function ArtifactLibraryOverlay({ open, onClose }: ArtifactLibraryOverlayProps) {
  const [items, setItems] = useState<ArtifactLibraryItem[]>([])
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState("")

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
    return items.filter(item => item.title.toLowerCase().includes(q))
  }, [items, query])

  async function remove(id: string) {
    setItems(prev => prev.filter(item => item.id !== id))
    await deleteArtifactRow(id)
  }

  if (!open || typeof document === "undefined") return null

  return createPortal(
    <div className="fixed inset-0 z-[90] bg-sidebar text-sidebar-foreground">
      <div className="flex h-full flex-col overflow-hidden">
        <div className="flex shrink-0 items-center gap-3 px-5 pb-4 pt-[max(1rem,env(safe-area-inset-top))]">
          <button onClick={onClose} className="-ml-1 rounded-full p-1.5 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground" aria-label="关闭作品库">
            <X className="size-5" />
          </button>
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-[16px] font-semibold tracking-tight">作品</h3>
          </div>
        </div>

        <div className="px-4 pb-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-sidebar-primary/70" />
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="搜索作品……"
              className="w-full rounded-xl border border-sidebar-primary/35 bg-sidebar-accent/40 py-2 pl-10 pr-3 text-[12px] outline-none placeholder:text-muted-foreground/50 transition-colors focus:border-sidebar-primary/70 focus:bg-sidebar-accent/60"
            />
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
          {loading ? (
            <div className="flex h-28 items-center justify-center text-muted-foreground">
              <Loader2 className="size-5 animate-spin" />
            </div>
          ) : filtered.length === 0 ? (
            <div className="mx-auto mt-10 flex max-w-xs flex-col items-center text-center">
              <div className="mb-4 flex size-14 items-center justify-center rounded-full bg-sidebar-accent/60 text-sidebar-primary">
                <Shapes className="size-6" />
              </div>
              <p className="font-heading text-base tracking-wide text-foreground">还没有作品</p>
            </div>
          ) : (
            <div className="space-y-1.5">
              {filtered.map(item => (
                <div key={item.id} className="group flex items-center gap-2 rounded-2xl border border-sidebar-accent/55 bg-sidebar-accent/28 px-3 py-2 transition-colors hover:bg-sidebar-accent/45">
                  <button onClick={() => openArtifactPreview(item)} className="min-w-0 flex-1 text-left">
                    <p className="truncate font-heading text-[13px] tracking-wide text-foreground">{item.title}</p>
                  </button>
                  <button onClick={() => openArtifactPreview(item)} className="rounded-lg p-1.5 text-muted-foreground/60 transition-colors hover:bg-sidebar-accent hover:text-foreground" aria-label="打开作品">
                    <ExternalLink className="size-4" />
                  </button>
                  <button onClick={() => remove(item.id)} className="rounded-lg p-1.5 text-muted-foreground/45 transition-colors hover:bg-sidebar-accent hover:text-destructive" aria-label="删除作品">
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
