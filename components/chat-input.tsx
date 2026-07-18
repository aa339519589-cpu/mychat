"use client"

import { useEffect, useState } from "react"
import { useReducedMotion } from "motion/react"
import { cn } from "@/lib/utils"
import { TIER_MAP, type Tier } from "@/lib/chat-data"
import type { AttachedFile } from "@/lib/file-extract"
import type { SearchMode } from "@/lib/search-mode"
import type { ModelEndpointSummary } from "@/lib/model-endpoints"
import { ModelPickerSheet } from "@/components/model-picker-sheet"
import { AttachmentPreview } from "@/components/chat-input-attachments"
import { ComposerBar } from "@/components/chat-input-bar"
import { ComposerTools } from "@/components/chat-input-tools"
import { useComposerState } from "@/components/chat-input-state"

export type ChatInputProps = {
  onSend: (text: string, images?: string[], files?: AttachedFile[]) => void
  activeTier: string
  onTierChange: (tier: Tier) => void
  mobile: boolean
  searchMode: SearchMode
  onSearchModeChange: (mode: SearchMode) => void
  deepResearch: boolean
  onDeepResearchChange: (value: boolean) => void
  historyRetrieval: boolean
  onHistoryRetrievalChange: (value: boolean) => void
  customEndpoints: ModelEndpointSummary[]
  activeEndpointId: string | null
  onEndpointChange: (id: string) => void
  disabled?: boolean
  isLoading: boolean
  onStop: () => void
}

export function ChatInput({
  onSend, activeTier, onTierChange, mobile, searchMode, onSearchModeChange,
  deepResearch, onDeepResearchChange, historyRetrieval, onHistoryRetrievalChange,
  customEndpoints, activeEndpointId, onEndpointChange, disabled = false, isLoading, onStop,
}: ChatInputProps) {
  const [plusOpen, setPlusOpen] = useState(false)
  const [tierMenuOpen, setTierMenuOpen] = useState(false)
  const reducedMotion = useReducedMotion()
  const state = useComposerState({ activeTier, onTierChange, onSend, disabled, isLoading, setPlusOpen })

  useEffect(() => {
    if (!plusOpen) return
    const handleClickOutside = (event: MouseEvent) => { if (state.plusMenuRef.current && !state.plusMenuRef.current.contains(event.target as Node)) setPlusOpen(false) }
    document.addEventListener("mousedown", handleClickOutside)
    return () => document.removeEventListener("mousedown", handleClickOutside)
  }, [plusOpen, state.plusMenuRef])

  const activeTierName = (TIER_MAP as Record<string, { label: string } | undefined>)[activeTier]?.label ?? "模型"
  const availableEndpoints = customEndpoints.filter(endpoint => !endpoint.needsReconnect)
  const activeEndpoint = availableEndpoints.find(endpoint => endpoint.id === activeEndpointId)
  const activeModelLabel = activeEndpoint?.name || activeEndpoint?.model || activeTierName
  const hasActiveTools = searchMode !== "off" || deepResearch || historyRetrieval
  const canSend = !disabled && !isLoading && !state.sendPending && (!!state.value.trim() || state.images.length > 0 || state.files.length > 0)

  function selectTier(id: string) {
    onTierChange(id as Tier)
    if (id === "绘影" || id === "录像") {
      onSearchModeChange("off")
      onDeepResearchChange(false)
      onHistoryRetrievalChange(false)
    }
    try { localStorage.setItem("chat_active_tier", id) } catch {}
    setTierMenuOpen(false)
  }

  return (
    <div className={cn("relative z-10 mx-auto w-full shrink-0", mobile ? "bg-background px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2" : "max-w-[56rem] px-10 pb-8 pt-2")}>
      <input ref={state.addInputRef} type="file" accept="image/*,.pdf,.txt,.md,.csv,.json,.log,.xml,.html,.yaml,.yml,text/*,application/pdf" multiple className="hidden" onChange={event => { state.handleAddFiles(event.target.files); event.currentTarget.value = "" }} />
      <AttachmentPreview images={state.images} files={state.files} fileLoading={state.fileLoading} fileError={state.fileError} onRemoveImage={index => state.setImages(previous => previous.filter((_, current) => current !== index))} onRemoveFile={index => state.setFiles(previous => previous.filter((_, current) => current !== index))} />
      <div className="flex min-w-0 items-end gap-1 rounded-[0.78rem] border border-border/50 bg-secondary/75 py-1.5 pl-1.5 pr-1.5 text-secondary-foreground shadow-sm transition-[border-color,box-shadow] duration-150 focus-within:border-ring/55 focus-within:shadow-md dark:border-white/10 dark:bg-[#151515] dark:text-white sm:gap-2 sm:pl-2 sm:pr-2">
        <ComposerTools open={plusOpen} onOpenChange={setPlusOpen} inputRef={state.addInputRef} containerRef={state.plusMenuRef} searchMode={searchMode} onSearchModeChange={onSearchModeChange} deepResearch={deepResearch} onDeepResearchChange={onDeepResearchChange} historyRetrieval={historyRetrieval} onHistoryRetrievalChange={onHistoryRetrievalChange} hasActiveTools={hasActiveTools} reducedMotion={reducedMotion} />
        <ComposerBar mobile={mobile} value={state.value} onValueChange={state.setValue} textareaRef={state.textAreaRef} onResize={state.resize} onSubmit={state.submit} disabled={disabled} isLoading={isLoading} sendPending={state.sendPending} activeTier={activeTier} activeModelLabel={activeModelLabel} activeOutputKind={activeEndpoint?.outputKind} canSend={canSend} onStop={onStop} onOpenModel={() => setTierMenuOpen(true)} />
      </div>
      <ModelPickerSheet open={tierMenuOpen} mobile={mobile} activeTier={activeTier} activeEndpointId={activeEndpointId} endpoints={availableEndpoints} onClose={() => setTierMenuOpen(false)} onSelectTier={selectTier} onSelectEndpoint={endpointId => { onEndpointChange(endpointId); setTierMenuOpen(false) }} />
    </div>
  )
}
