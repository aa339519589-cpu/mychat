"use client"

import type { RefObject, ReactNode } from "react"
import { AnimatePresence, motion } from "motion/react"
import { Check, Globe, Microscope, Paperclip, Plus, Search, Telescope } from "lucide-react"
import { cn } from "@/lib/utils"
import type { SearchMode } from "@/lib/search-mode"
import { POPOVER_SPRING, transitionFor } from "@/components/motion/fluid"

export function ComposerTools({ open, onOpenChange, inputRef, containerRef, searchMode, onSearchModeChange, deepResearch, onDeepResearchChange, historyRetrieval, onHistoryRetrievalChange, hasActiveTools, reducedMotion }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  inputRef: RefObject<HTMLInputElement | null>
  containerRef: RefObject<HTMLDivElement | null>
  searchMode: SearchMode
  onSearchModeChange: (mode: SearchMode) => void
  deepResearch: boolean
  onDeepResearchChange: (value: boolean) => void
  historyRetrieval: boolean
  onHistoryRetrievalChange: (value: boolean) => void
  hasActiveTools: boolean
  reducedMotion: boolean | null
}) {
  return (
    <div ref={containerRef} className="relative mb-0.5 shrink-0">
      <AnimatePresence initial={false}>{open && <motion.div key="composer-tools" initial={reducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.94, y: 6 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={reducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: 4 }} transition={transitionFor(reducedMotion, POPOVER_SPRING)} className="fluid-material-strong absolute bottom-full left-0 mb-2 w-[9rem] origin-bottom-left overflow-hidden rounded-xl border border-border/60 p-1"><PlusItem icon={<Paperclip className="size-4" />} label="添加" onClick={() => { onOpenChange(false); inputRef.current?.click() }} /><div className="border-t border-border/40" /><PlusItem icon={<Globe className={cn("size-4", searchMode === "web" && "text-primary")} />} label="联网" onClick={() => onSearchModeChange(searchMode === "web" ? "off" : "web")} active={searchMode === "web"} /><PlusItem icon={<Search className={cn("size-4 scale-x-[-1]", historyRetrieval && "text-primary")} />} label="检索" onClick={() => onHistoryRetrievalChange(!historyRetrieval)} active={historyRetrieval} /><PlusItem icon={<Telescope className={cn("size-4", searchMode === "deep" && "text-primary")} />} label="深度联网" onClick={() => onSearchModeChange(searchMode === "deep" ? "off" : "deep")} active={searchMode === "deep"} /><PlusItem icon={<Microscope className={cn("size-4", deepResearch && "text-primary")} />} label="深度研究" onClick={() => onDeepResearchChange(!deepResearch)} active={deepResearch} /></motion.div>}</AnimatePresence>
      <button onClick={() => onOpenChange(!open)} aria-label="添加" className={cn("fluid-press fluid-icon-press relative flex size-11 items-center justify-center rounded-full", open ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-background/40 hover:text-foreground dark:hover:bg-white/10")}><motion.span initial={false} animate={{ rotate: open ? 45 : 0 }} transition={transitionFor(reducedMotion)}><Plus className="size-4" /></motion.span>{hasActiveTools && !open && <span className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-primary ring-2 ring-card" />}</button>
    </div>
  )
}

function PlusItem({ icon, label, onClick, active }: { icon: ReactNode; label: string; onClick: () => void; active?: boolean }) {
  return <button onClick={onClick} className={cn("fluid-press fluid-touch-target flex min-h-11 w-full items-center gap-2 rounded-lg px-2.5 py-2 text-[12px] hover:bg-secondary/60", active ? "text-primary" : "text-muted-foreground")}><span className="shrink-0">{icon}</span><span className="flex-1 truncate text-left">{label}</span>{active && <Check className="size-3.5 shrink-0 text-primary" />}</button>
}
