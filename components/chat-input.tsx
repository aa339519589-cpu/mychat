"use client"

import { useEffect, useState } from "react"
import { useReducedMotion } from "motion/react"
import { cn } from "@/lib/utils"
import type { Tier } from "@/lib/chat-data"
import type { AttachedFile } from "@/lib/file-extract"
import type { SearchMode } from "@/lib/search-mode"
import type { ModelCatalogItem } from "@/lib/model-catalog"
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
  historyRetrieval: boolean
  onHistoryRetrievalChange: (value: boolean) => void
  renderEnabled: boolean
  onRenderEnabledChange: (value: boolean) => void
  models: ModelCatalogItem[]
  endpoints?: ModelEndpointSummary[]
  activeModelId: string | null
  activeModel: ModelCatalogItem | null
  activeEndpointId?: string | null
  activeEndpoint?: ModelEndpointSummary | null
  onModelChange: (model: ModelCatalogItem) => void
  onEndpointChange?: (id: string) => void
  reasoningEffort: string | null
  onReasoningChange: (value: string) => void
  disabled?: boolean
  isLoading: boolean
  onStop: () => void
}

export function ChatInput({
  onSend, activeTier, onTierChange, mobile, searchMode, onSearchModeChange,
  historyRetrieval, onHistoryRetrievalChange, renderEnabled, onRenderEnabledChange, models, endpoints = [], activeModelId, activeModel,
  activeEndpointId = null, activeEndpoint = null, onModelChange, onEndpointChange, reasoningEffort, onReasoningChange, disabled = false, isLoading, onStop,
}: ChatInputProps) {
  const [plusOpen, setPlusOpen] = useState(false)
  const [modelPickerOpen, setModelPickerOpen] = useState(false)
  const reducedMotion = useReducedMotion()
  const state = useComposerState({ activeTier, onTierChange, onSend, disabled, isLoading, setPlusOpen })

  useEffect(() => {
    if (!plusOpen) return
    const handleClickOutside = (event: MouseEvent) => { if (state.plusMenuRef.current && !state.plusMenuRef.current.contains(event.target as Node)) setPlusOpen(false) }
    document.addEventListener("mousedown", handleClickOutside)
    return () => document.removeEventListener("mousedown", handleClickOutside)
  }, [plusOpen, state.plusMenuRef])

  const activeModelLabel = activeEndpoint?.name ?? activeModel?.name ?? "模型"
  const activeProvider = activeEndpoint ? "API" : activeModel?.provider
  const activeOutputKind = activeEndpoint?.outputKind ?? activeModel?.outputKind
  const hasActiveTools = searchMode !== "off" || historyRetrieval || renderEnabled
  const canSend = !disabled && !isLoading && !state.sendPending && Boolean(activeEndpoint || activeModel) && (!!state.value.trim() || state.images.length > 0 || state.files.length > 0)

  return (
    <div className={cn("relative z-10 mx-auto w-full shrink-0", mobile ? "bg-background px-3 pb-[max(0.65rem,env(safe-area-inset-bottom))] pt-1.5" : "max-w-[56rem] px-10 pb-7 pt-1.5")}>
      <input ref={state.addInputRef} type="file" accept="image/*,.pdf,.txt,.md,.csv,.json,.log,.xml,.html,.yaml,.yml,text/*,application/pdf" multiple className="hidden" onChange={event => { state.handleAddFiles(event.target.files); event.currentTarget.value = "" }} />
      <AttachmentPreview images={state.images} files={state.files} fileLoading={state.fileLoading} fileError={state.fileError} onRemoveImage={index => state.setImages(previous => previous.filter((_, current) => current !== index))} onRemoveFile={index => state.setFiles(previous => previous.filter((_, current) => current !== index))} />
      <div className="flex min-w-0 flex-wrap items-center gap-x-0.5 rounded-[1.15rem] border border-[var(--chat-surface-border)] bg-[var(--chat-surface)] px-2.5 pb-1.5 pt-2 text-card-foreground shadow-[0_2px_10px_rgba(8,8,8,0.025)] transition-[border-color,box-shadow] duration-150 focus-within:border-[color-mix(in_srgb,var(--chat-surface-border)_72%,var(--foreground))] focus-within:shadow-[0_3px_13px_rgba(8,8,8,0.04)] sm:gap-x-1 sm:px-3">
        <ComposerTools open={plusOpen} onOpenChange={setPlusOpen} inputRef={state.addInputRef} containerRef={state.plusMenuRef} searchMode={searchMode} onSearchModeChange={onSearchModeChange} historyRetrieval={historyRetrieval} onHistoryRetrievalChange={onHistoryRetrievalChange} renderEnabled={renderEnabled} onRenderEnabledChange={onRenderEnabledChange} hasActiveTools={hasActiveTools} reducedMotion={reducedMotion} reasoningEffort={reasoningEffort} reasoningOptions={activeEndpoint ? [] : activeModel?.reasoningEfforts ?? []} onReasoningChange={onReasoningChange} />
        <ComposerBar
          mobile={mobile}
          value={state.value}
          onValueChange={state.setValue}
          textareaRef={state.textAreaRef}
          onResize={state.resize}
          onSubmit={state.submit}
          disabled={disabled}
          isLoading={isLoading}
          sendPending={state.sendPending}
          activeModelLabel={activeModelLabel}
          activeModelProvider={activeProvider}
          activeOutputKind={activeOutputKind}
          canSend={canSend}
          onStop={onStop}
          onOpenModel={() => setModelPickerOpen(true)}
        />
      </div>
      <ModelPickerSheet
        open={modelPickerOpen}
        mobile={mobile}
        models={models}
        endpoints={endpoints}
        activeModelId={activeModelId}
        activeEndpointId={activeEndpointId}
        onClose={() => setModelPickerOpen(false)}
        onSelect={onModelChange}
        onEndpointSelect={onEndpointChange ? endpoint => onEndpointChange(endpoint.id) : undefined}
      />
    </div>
  )
}
