"use client"

import type { RefObject, ReactNode } from "react"
import { AnimatePresence, motion } from "motion/react"
import { Brain, Check, Globe, Paperclip, Plus, Search, Telescope } from "lucide-react"
import { cn } from "@/lib/utils"
import type { SearchMode } from "@/lib/search-mode"
import { POPOVER_SPRING, transitionFor } from "@/components/motion/fluid"

export function ComposerTools({
  open, onOpenChange, inputRef, containerRef, searchMode, onSearchModeChange,
  historyRetrieval, onHistoryRetrievalChange, hasActiveTools, reducedMotion,
  reasoningEffort, reasoningOptions, onReasoningChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  inputRef: RefObject<HTMLInputElement | null>
  containerRef: RefObject<HTMLDivElement | null>
  searchMode: SearchMode
  onSearchModeChange: (mode: SearchMode) => void
  historyRetrieval: boolean
  onHistoryRetrievalChange: (value: boolean) => void
  hasActiveTools: boolean
  reducedMotion: boolean | null
  reasoningEffort: string | null
  reasoningOptions: string[]
  onReasoningChange: (value: string) => void
}) {
  return (
    <div ref={containerRef} className="relative order-2 flex shrink-0 items-center gap-0.5">
      <AnimatePresence initial={false}>{open && <motion.div key="composer-tools" initial={reducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.94, y: 6 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={reducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: 4 }} transition={transitionFor(reducedMotion, POPOVER_SPRING)} className="fluid-material-strong absolute bottom-full left-0 mb-2 w-[9.5rem] origin-bottom-left overflow-hidden rounded-2xl border border-border/70 p-1.5"><PlusItem icon={<Paperclip className="size-4" />} label="添加" onClick={() => { onOpenChange(false); inputRef.current?.click() }} /><div className="mx-2 border-t border-border/50" /><PlusItem icon={<Globe className={cn("size-4", searchMode === "web" && "text-foreground")} />} label="联网" onClick={() => onSearchModeChange(searchMode === "web" ? "off" : "web")} active={searchMode === "web"} /><PlusItem icon={<Search className={cn("size-4 scale-x-[-1]", historyRetrieval && "text-foreground")} />} label="检索" onClick={() => onHistoryRetrievalChange(!historyRetrieval)} active={historyRetrieval} /><PlusItem icon={<Telescope className={cn("size-4", searchMode === "deep" && "text-foreground")} />} label="深度联网" onClick={() => onSearchModeChange(searchMode === "deep" ? "off" : "deep")} active={searchMode === "deep"} /></motion.div>}</AnimatePresence>
      <button onClick={() => onOpenChange(!open)} aria-label="添加" className={cn("fluid-press fluid-icon-press relative flex size-11 items-center justify-center rounded-full", open ? "bg-secondary text-foreground" : "text-[#929292] hover:bg-secondary/70 hover:text-foreground dark:text-white/55 dark:hover:bg-white/10 dark:hover:text-white")}><motion.span initial={false} animate={{ rotate: open ? 45 : 0 }} transition={transitionFor(reducedMotion)}><Plus className="size-5" /></motion.span>{hasActiveTools && !open && <span className="absolute right-0.5 top-0.5 size-1.5 rounded-full bg-foreground ring-2 ring-card dark:bg-white" />}</button>
      <QuickTool label="联网" active={searchMode === "web"} onClick={() => onSearchModeChange(searchMode === "web" ? "off" : "web")} icon={<Globe className="size-[1.15rem]" />} />
      <ReasoningTool value={reasoningEffort} options={reasoningOptions} onChange={onReasoningChange} reducedMotion={reducedMotion} />
    </div>
  )
}

function ReasoningTool({ value, options, onChange, reducedMotion }: { value: string | null; options: string[]; onChange: (value: string) => void; reducedMotion: boolean | null }) {
  const disabled = options.length === 0
  const [menuOpen, setMenuOpen] = useReasoningMenu(disabled)
  const active = Boolean(value && value !== "none")
  return (
    <div className="relative">
      <button type="button" disabled={disabled} onClick={() => setMenuOpen(!menuOpen)} aria-label="Thinking depth" aria-expanded={disabled ? undefined : menuOpen} className={cn("fluid-press fluid-icon-press flex size-11 items-center justify-center rounded-full transition-colors", disabled ? "cursor-not-allowed text-muted-foreground/25" : active ? "bg-secondary text-foreground" : "text-[#B0B0B0] hover:bg-secondary/70 hover:text-foreground dark:text-white/40 dark:hover:bg-white/10 dark:hover:text-white")}><Brain className="size-[1.15rem]" /></button>
      <AnimatePresence initial={false}>{menuOpen && !disabled && <motion.div initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 5, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 4, scale: 0.97 }} transition={transitionFor(reducedMotion, POPOVER_SPRING)} className="fluid-material-strong absolute bottom-full left-1/2 z-30 mb-2 min-w-[8.5rem] -translate-x-1/2 overflow-hidden rounded-2xl border border-border/70 p-1.5 shadow-lg">{options.map(option => <button key={option} type="button" onClick={() => { onChange(option); setMenuOpen(false) }} className="fluid-press flex min-h-10 w-full items-center justify-between rounded-xl px-3 text-left text-[12px] text-foreground hover:bg-secondary/70"><span>{effortLabel(option)}</span>{value === option && <Check className="size-3.5" />}</button>)}</motion.div>}</AnimatePresence>
    </div>
  )
}

function useReasoningMenu(disabled: boolean): [boolean, (value: boolean) => void] {
  const React = require("react") as typeof import("react")
  const [open, setOpen] = React.useState(false)
  React.useEffect(() => { if (disabled) setOpen(false) }, [disabled])
  return [open, setOpen]
}

function effortLabel(value: string): string {
  if (value === "none") return "Off"
  if (value === "xhigh") return "XHigh"
  return value.slice(0, 1).toUpperCase() + value.slice(1)
}

function QuickTool({ icon, label, onClick, active }: { icon: ReactNode; label: string; onClick: () => void; active: boolean }) {
  return <button type="button" onClick={onClick} aria-label={label} aria-pressed={active} className={cn("fluid-press fluid-icon-press flex size-11 items-center justify-center rounded-full transition-colors", active ? "bg-secondary text-foreground" : "text-[#B0B0B0] hover:bg-secondary/70 hover:text-foreground dark:text-white/40 dark:hover:bg-white/10 dark:hover:text-white")}><span className="shrink-0">{icon}</span></button>
}

function PlusItem({ icon, label, onClick, active }: { icon: ReactNode; label: string; onClick: () => void; active?: boolean }) {
  return <button onClick={onClick} className={cn("fluid-press fluid-touch-target flex min-h-11 w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-[13px] hover:bg-secondary/70", active ? "text-foreground" : "text-muted-foreground")}><span className="shrink-0">{icon}</span><span className="flex-1 truncate text-left">{label}</span>{active && <Check className="size-3.5 shrink-0 text-foreground" />}</button>
}
