"use client"

import { Check, ChevronRight, Eye, Image as ImageIcon, Wrench } from "lucide-react"
import type { ModelCatalogItem } from "@/lib/model-catalog"
import { cn } from "@/lib/utils"

export function ModelCatalogList({ models, activeModelId, onSelect, compact = false }: {
  models: ModelCatalogItem[]
  activeModelId: string | null
  onSelect?: (model: ModelCatalogItem) => void
  compact?: boolean
}) {
  if (models.length === 0) {
    return <div className="flex min-h-40 items-center justify-center px-6 text-center text-sm text-muted-foreground">模型目录暂时不可用</div>
  }
  return (
    <div className={cn("divide-y divide-border/55 dark:divide-white/8", !compact && "rounded-2xl border border-border/60 bg-card/42 dark:border-white/10 dark:bg-white/[0.025]")}>
      {models.map(model => (
        <ModelCatalogRow
          key={model.id}
          model={model}
          active={model.id === activeModelId}
          onSelect={onSelect}
          compact={compact}
        />
      ))}
    </div>
  )
}

function ModelCatalogRow({ model, active, onSelect, compact }: {
  model: ModelCatalogItem
  active: boolean
  onSelect?: (model: ModelCatalogItem) => void
  compact: boolean
}) {
  const interactive = Boolean(onSelect) && model.access !== "premium"
  const tags = [
    model.provider,
    ...(model.flagship ? ["旗舰"] : []),
    ...(model.vision ? ["视觉识别"] : []),
    ...(model.tools ? ["函数调用"] : []),
  ]
  return (
    <button
      type="button"
      onClick={() => { if (interactive) onSelect?.(model) }}
      aria-current={active ? "true" : undefined}
      className={cn(
        "group flex w-full min-w-0 items-center gap-3 text-left transition-colors",
        compact ? "min-h-[4.85rem] px-3.5 py-3" : "min-h-[5.25rem] px-4 py-3.5",
        interactive && "hover:bg-secondary/45 active:bg-secondary/65",
        active && "bg-secondary/55",
      )}
    >
      <ProviderMark provider={model.provider} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[15px] font-medium tracking-[-0.01em] text-foreground">{model.name}</span>
          {model.access === "premium" && <span className="shrink-0 rounded-md border border-[#C76747] bg-[#D77A56] px-1.5 py-0.5 text-[10px] font-semibold text-white shadow-[0_1px_2px_rgba(112,48,27,0.16)] dark:border-[#E28A67] dark:bg-[#C96F4D] dark:text-white">会员</span>}
          {model.outputKind === "image" && <ImageIcon className="size-3.5 shrink-0 text-muted-foreground" />}
        </div>
        <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-1.5">
          {tags.map(tag => <span key={tag} className="rounded-md bg-secondary/65 px-1.5 py-0.5 text-[10px] text-muted-foreground">{tag}</span>)}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2.5 pl-1">
        <PricePair model={model} />
        {active ? <Check className="size-4 text-foreground" /> : <ChevronRight className="size-4 text-muted-foreground/45" />}
      </div>
    </button>
  )
}

function PricePair({ model }: { model: ModelCatalogItem }) {
  return (
    <div className="grid min-w-[4.6rem] grid-cols-2 gap-1 text-right font-mono text-[10px] leading-tight text-muted-foreground">
      <span title="输入价格 / 百万 Token">{price(model.promptPrice)}</span>
      <span title="输出价格 / 百万 Token">{price(model.completionPrice)}</span>
    </div>
  )
}

function price(value: number): string {
  if (!Number.isFinite(value)) return "—"
  if (value === 0) return "0"
  if (value < 0.01) return value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "")
  if (value < 1) return value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")
  return value.toFixed(value >= 100 ? 0 : 1).replace(/\.0$/, "")
}

function ProviderMark({ provider }: { provider: string }) {
  return (
    <span className="flex size-9 shrink-0 items-center justify-center text-foreground">
      <ProviderLogo provider={provider} />
      <span className="sr-only">{provider}</span>
    </span>
  )
}

function ProviderLogo({ provider }: { provider: string }) {
  if (provider === "OpenAI") return <OpenAiMark />
  if (provider === "Anthropic") return <AnthropicMark />
  if (provider === "Google") return <GeminiMark />
  if (provider === "DeepSeek") return <DeepSeekMark />
  if (provider === "MiniMax") return <MiniMaxMark />
  if (provider === "Moonshot") return <MoonshotMark />
  return <ZaiMark />
}

function OpenAiMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-7" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3.1a4.2 4.2 0 0 1 4.2 4.2v2.5L12 12.2 7.8 9.8V7.3A4.2 4.2 0 0 1 12 3.1Z" />
      <path d="M19.7 7.6a4.2 4.2 0 0 1-1.5 5.7L16 14.6l-4-2.4v-4.8l2.2-1.3a4.2 4.2 0 0 1 5.5 1.5Z" />
      <path d="M19.7 16.4a4.2 4.2 0 0 1-5.7 1.5L11.8 16v-4.8l4.2-2.4 2.2 1.3a4.2 4.2 0 0 1 1.5 6.3Z" />
      <path d="M12 20.9a4.2 4.2 0 0 1-4.2-4.2v-2.5l4.2-2.4 4.2 2.4v2.5A4.2 4.2 0 0 1 12 20.9Z" />
      <path d="M4.3 16.4a4.2 4.2 0 0 1 1.5-5.7L8 9.4l4 2.4v4.8l-2.2 1.3a4.2 4.2 0 0 1-5.5-1.5Z" />
      <path d="M4.3 7.6A4.2 4.2 0 0 1 10 6.1L12.2 8v4.8L8 15.2l-2.2-1.3a4.2 4.2 0 0 1-1.5-6.3Z" />
    </svg>
  )
}

function AnthropicMark() {
  const rays = Array.from({ length: 12 }, (_, index) => index * 30)
  return (
    <svg viewBox="0 0 24 24" className="size-7 text-[#D87552]" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round">
      {rays.map(angle => <path key={angle} d="M12 2.4v5.1" transform={`rotate(${angle} 12 12)`} />)}
      <circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none" />
    </svg>
  )
}

function GeminiMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-7" aria-hidden="true">
      <path d="M12 2.2c.8 5.4 3.1 8.2 8.7 9.8-5.6 1.6-7.9 4.4-8.7 9.8-.8-5.4-3.1-8.2-8.7-9.8C8.9 10.4 11.2 7.6 12 2.2Z" fill="#4285F4" />
      <path d="M12 2.2c.3 4.8 1.8 7.7 4.9 9.8H12V2.2Z" fill="#EA4335" />
      <path d="M12 21.8c-.3-4.8-1.8-7.7-4.9-9.8H12v9.8Z" fill="#34A853" />
      <path d="M3.3 12c3.6-1 6.1-2.6 8.7-5.7V12H3.3Z" fill="#FBBC05" />
    </svg>
  )
}

function MiniMaxMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-7 text-[#F04C75]" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round">
      <path d="M4 9v6M7 6v12M10 4v16M13 7v10M16 5v14M19 8v8" />
      <path d="M2.5 11v2M21.5 10v4" opacity=".8" />
    </svg>
  )
}

function DeepSeekMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-7 text-[#4F6FFF]" aria-hidden="true" fill="currentColor">
      <path d="M3.1 13.5c.4-4.6 4.2-7.6 8.7-7.6 2.2 0 4.1.7 5.6 2.1 1.1-.1 2.3-.6 3.3-1.5-.1 1.8-.8 3.2-2.1 4.1.9.1 1.8 0 2.6-.2-.7 1.3-1.7 2.2-3 2.7-.7 3.4-3.5 5.8-7.2 5.8-3.5 0-6.8-2-7.9-5.4Zm4.1-.8c.5 2.1 2.2 3.4 4.3 3.4 1.7 0 3.1-.7 4-2-2 .7-4.6.1-6.2-1.5-.6-.6-1.4-.5-2.1.1Z" />
      <circle cx="10.4" cy="10" r=".8" fill="white" />
    </svg>
  )
}

function MoonshotMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-7" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.35" strokeLinecap="square" strokeLinejoin="miter">
      <path d="M5 4v16M6.2 13.2 16.5 4M9.8 10.2 18.5 20" />
      <circle cx="19.1" cy="3.6" r="1.5" fill="currentColor" stroke="none" />
    </svg>
  )
}

function ZaiMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-7" aria-hidden="true" fill="currentColor">
      <path d="M3 4h17.8l-4.2 5.2H8.8L3 4Zm5.3 6.4h8.9L9.4 20H2.8l5.5-6.7v-2.9ZM10.7 14.8h7.7L21.2 20H6.5l4.2-5.2Z" />
    </svg>
  )
}

export function ModelCapabilitySummary({ model }: { model: ModelCatalogItem }) {
  return <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">{model.vision && <Eye className="size-3" />}{model.tools && <Wrench className="size-3" />}</span>
}
