"use client"

import Image from "next/image"
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
  const interactive = Boolean(onSelect) && (model.access !== "premium" || model.ownerUnlocked === true)
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

const PROVIDER_LOGOS: Record<string, { src: string; monochrome?: boolean }> = {
  OpenAI: { src: "/provider-icons/openai.svg", monochrome: true },
  Anthropic: { src: "/provider-icons/claude-color.svg" },
  Google: { src: "/provider-icons/gemini-color.svg" },
  DeepSeek: { src: "/provider-icons/deepseek-color.svg" },
  MiniMax: { src: "/provider-icons/minimax-color.svg" },
  Moonshot: { src: "/provider-icons/kimi.svg", monochrome: true },
  "Z.ai": { src: "/provider-icons/zai.svg", monochrome: true },
  xAI: { src: "/provider-icons/grok.svg", monochrome: true },
}

function ProviderLogo({ provider }: { provider: string }) {
  const logo = PROVIDER_LOGOS[provider] ?? PROVIDER_LOGOS["Z.ai"]
  return (
    <Image
      src={logo.src}
      alt=""
      width={28}
      height={28}
      unoptimized
      aria-hidden="true"
      className={cn("size-7 object-contain", logo.monochrome && "dark:invert")}
    />
  )
}

export function ModelCapabilitySummary({ model }: { model: ModelCatalogItem }) {
  return <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">{model.vision && <Eye className="size-3" />}{model.tools && <Wrench className="size-3" />}</span>
}
