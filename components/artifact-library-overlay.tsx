"use client"

import { useEffect, useMemo, useState } from "react"
import { createPortal } from "react-dom"
import { motion, useDragControls, useReducedMotion } from "motion/react"
import { Shapes, X, Trash2, ExternalLink, Loader2, Search } from "lucide-react"
import type { ArtifactLibraryItem } from "@/lib/artifact-data"
import { fetchArtifacts, deleteArtifactRow } from "@/lib/data"
import { PANEL_SPRING, shouldDismissGesture, transitionFor } from "@/components/motion/fluid"

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
  const reducedMotion = useReducedMotion()
  const dragControls = useDragControls()

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    fetchArtifacts()
      .then(rows => { if (!cancelled) setItems(rows) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose()
    }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [onClose, open])

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
    <motion.div
      role="dialog"
      aria-modal="true"
      aria-labelledby="artifact-library-title"
      initial={reducedMotion ? { opacity: 0 } : { opacity: 0, x: -28, scale: 0.99 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={reducedMotion ? { opacity: 0 } : { opacity: 0, x: -28, scale: 0.99 }}
      transition={transitionFor(reducedMotion, PANEL_SPRING)}
      drag={!reducedMotion ? "x" : false}
      dragControls={dragControls}
      dragListener={false}
      dragConstraints={{ left: 0, right: 0 }}
      dragElastic={{ left: 0.04, right: 0.28 }}
      dragMomentum={false}
      dragSnapToOrigin
      onDragEnd={(_, info) => {
        if (shouldDismissGesture({
          offset: info.offset.x,
          velocity: info.velocity.x,
          size: window.innerWidth,
          direction: "positive",
        })) onClose()
      }}
      className="fixed inset-0 z-[90] bg-sidebar text-sidebar-foreground"
    >
      <div className="flex h-full flex-col overflow-hidden">
        <ArtifactLibraryHeader reducedMotion={reducedMotion} dragControls={dragControls} onClose={onClose} query={query} onQueryChange={setQuery} />
        <ArtifactLibraryResults loading={loading} items={filtered} onRemove={remove} />
      </div>
    </motion.div>,
    document.body,
  )
}

function ArtifactLibraryHeader({ reducedMotion, dragControls, onClose, query, onQueryChange }: {
  reducedMotion: boolean | null
  dragControls: ReturnType<typeof useDragControls>
  onClose: () => void
  query: string
  onQueryChange: (query: string) => void
}) {
  return (
    <>
      <div className="fluid-material flex shrink-0 items-center gap-2 px-4 pb-2 pt-[max(0.5rem,env(safe-area-inset-top))]">
        <button onClick={onClose} className="fluid-press fluid-icon-press flex size-11 items-center justify-center rounded-full text-muted-foreground hover:bg-sidebar-accent hover:text-foreground" aria-label="关闭作品库"><X className="size-5" /></button>
        <div onPointerDown={event => { if (!reducedMotion) dragControls.start(event) }} className="flex min-h-11 min-w-0 flex-1 touch-none items-center">
          <h3 id="artifact-library-title" className="truncate text-[16px] font-semibold tracking-normal">作品</h3>
        </div>
      </div>
      <div className="px-4 pb-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-sidebar-primary/70" />
          <input value={query} onChange={event => onQueryChange(event.target.value)} placeholder="搜索作品……" className="min-h-11 w-full rounded-xl border border-sidebar-primary/35 bg-sidebar-accent/40 py-2 pl-10 pr-3 text-[12px] outline-none placeholder:text-muted-foreground/50 transition-colors focus:border-sidebar-primary/70 focus:bg-sidebar-accent/60" />
        </div>
      </div>
    </>
  )
}

function ArtifactLibraryResults({ loading, items, onRemove }: {
  loading: boolean
  items: ArtifactLibraryItem[]
  onRemove: (id: string) => Promise<void>
}) {
  return (
    <div className="fluid-scroll min-h-0 flex-1 overflow-y-auto px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
      {loading ? <div className="flex h-28 items-center justify-center text-muted-foreground"><Loader2 className="size-5 animate-spin" /></div>
        : items.length === 0 ? <div className="mx-auto mt-10 flex max-w-xs flex-col items-center text-center"><div className="mb-4 flex size-14 items-center justify-center rounded-full bg-sidebar-accent/60 text-sidebar-primary"><Shapes className="size-6" /></div><p className="font-heading text-base tracking-wide text-foreground">还没有作品</p></div>
        : <div className="space-y-1.5">{items.map(item => <ArtifactLibraryRow key={item.id} item={item} onRemove={onRemove} />)}</div>}
    </div>
  )
}

function ArtifactLibraryRow({ item, onRemove }: { item: ArtifactLibraryItem; onRemove: (id: string) => Promise<void> }) {
  return (
    <div className="group flex min-h-14 items-center gap-1 rounded-xl border border-sidebar-accent/55 bg-sidebar-accent/28 px-2 py-1 transition-colors hover:bg-sidebar-accent/45">
      <button onClick={() => openArtifactPreview(item)} className="fluid-press min-h-11 min-w-0 flex-1 rounded-lg px-1 text-left"><p className="truncate font-heading text-[13px] tracking-normal text-foreground">{item.title}</p></button>
      <button onClick={() => openArtifactPreview(item)} className="fluid-press fluid-icon-press flex size-11 items-center justify-center rounded-lg text-muted-foreground/60 hover:bg-sidebar-accent hover:text-foreground" aria-label="打开作品"><ExternalLink className="size-4" /></button>
      <button onClick={() => { void onRemove(item.id) }} className="fluid-press fluid-icon-press flex size-11 items-center justify-center rounded-lg text-muted-foreground/45 hover:bg-sidebar-accent hover:text-destructive" aria-label="删除作品"><Trash2 className="size-3.5" /></button>
    </div>
  )
}
