"use client"

import { useEffect } from "react"
import { AnimatePresence, motion, useDragControls, useReducedMotion } from "motion/react"
import { Check, ChevronRight, Server, X } from "lucide-react"

import { ModelCatalogList } from "@/components/model-catalog-list"
import { MOMENTUM_SPRING, shouldDismissGesture, transitionFor } from "@/components/motion/fluid"
import type { ModelCatalogItem } from "@/lib/model-catalog"
import type { ModelEndpointSummary } from "@/lib/model-endpoints"
import { cn } from "@/lib/utils"

function ModelGroupDivider({ models, baseCount }: { models: ModelCatalogItem[]; baseCount: number }) {
  const sample = models.find(model =>
    model.trialUnlimited === true
    || typeof model.trialRemaining === "number"
    || typeof model.trialLimit === "number",
  )
  const limit = typeof sample?.trialLimit === "number" ? sample.trialLimit : 3
  const remaining = typeof sample?.trialRemaining === "number" ? sample.trialRemaining : null
  const unlimited = sample?.trialUnlimited === true
  const accessCopy = unlimited || remaining === null
    ? `以下模型：会员不限次数，非会员共 ${limit} 次`
    : `以下模型：会员不限次数，非会员剩余 ${remaining} 次`

  return (
    <div className="px-3 py-4">
      <div className="flex items-center gap-2.5">
        <span className="h-[2px] flex-1 rounded-full bg-foreground/30 dark:bg-white/30" />
        <span className="shrink-0 rounded-full border border-foreground/20 bg-background/90 px-3 py-1 text-[12px] font-semibold tracking-[0.02em] text-foreground dark:border-white/20 dark:bg-black/20">以上 {baseCount} 个为基础模型</span>
        <span className="h-[2px] flex-1 rounded-full bg-foreground/30 dark:bg-white/30" />
      </div>
      <p className={cn(
        "mx-auto mt-2.5 w-fit rounded-full border px-3 py-1 text-center text-[12px] font-semibold",
        remaining === 0
          ? "border-destructive/45 bg-destructive/10 text-destructive"
          : "border-border/80 bg-secondary/65 text-foreground/85 dark:border-white/15 dark:bg-white/8",
      )}>
        {accessCopy}
      </p>
    </div>
  )
}

function EndpointList({ endpoints, activeEndpointId, onSelect }: {
  endpoints: ModelEndpointSummary[]
  activeEndpointId: string | null
  onSelect?: (endpoint: ModelEndpointSummary) => void
}) {
  if (endpoints.length === 0) return null
  return (
    <div className="mb-2">
      <div className="px-3.5 pb-1.5 pt-2 text-[11px] font-semibold tracking-[0.08em] text-muted-foreground">自定义 API</div>
      <div className="divide-y divide-border/55 dark:divide-white/8">
        {endpoints.map(endpoint => {
          const active = endpoint.id === activeEndpointId
          const disabled = endpoint.needsReconnect || !onSelect
          return (
            <button
              key={endpoint.id}
              type="button"
              disabled={disabled}
              onClick={() => { if (!disabled) onSelect?.(endpoint) }}
              aria-current={active ? "true" : undefined}
              className={cn(
                "group flex min-h-[4.85rem] w-full min-w-0 items-center gap-3 px-3.5 py-3 text-left transition-colors",
                !disabled && "hover:bg-secondary/45 active:bg-secondary/65",
                active && "bg-secondary/55",
                disabled && "cursor-not-allowed opacity-45",
              )}
            >
              <div className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-border/70 bg-secondary/35 dark:border-white/10 dark:bg-white/5">
                <Server className="size-4 text-muted-foreground" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-[15px] font-medium tracking-[-0.01em] text-foreground">{endpoint.name}</span>
                  {endpoint.needsReconnect && <span className="shrink-0 rounded-md bg-secondary/70 px-1.5 py-0.5 text-[10px] text-muted-foreground">需重连</span>}
                </div>
                <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-1.5">
                  <span className="max-w-[15rem] truncate rounded-md bg-secondary/65 px-1.5 py-0.5 text-[10px] text-muted-foreground">{endpoint.model}</span>
                  <span className="rounded-md bg-secondary/65 px-1.5 py-0.5 text-[10px] text-muted-foreground">API</span>
                </div>
              </div>
              {active ? <Check className="size-4 shrink-0 text-foreground" /> : <ChevronRight className="size-4 shrink-0 text-muted-foreground/45" />}
            </button>
          )
        })}
      </div>
      <div className="mx-3.5 my-2 h-px bg-border/60 dark:bg-white/10" />
    </div>
  )
}

export function ModelPickerSheet({ open, mobile, models, endpoints = [], activeModelId, activeEndpointId = null, onClose, onSelect, onEndpointSelect }: {
  open: boolean
  mobile: boolean
  models: ModelCatalogItem[]
  endpoints?: ModelEndpointSummary[]
  activeModelId: string | null
  activeEndpointId?: string | null
  onClose: () => void
  onSelect: (model: ModelCatalogItem) => void
  onEndpointSelect?: (endpoint: ModelEndpointSummary) => void
}) {
  const dragControls = useDragControls()
  const reducedMotion = useReducedMotion()
  const baseModels = models.filter(model => model.access === "quota")
  const otherModels = models.filter(model => model.access !== "quota")

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose() }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [onClose, open])

  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          key="model-picker"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          transition={transitionFor(reducedMotion)}
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/42 px-2 pb-2 pt-[18dvh] backdrop-blur-[2px] md:items-center md:p-4"
        >
          <button className="absolute inset-0 cursor-default" aria-label="关闭模型选择" onClick={onClose} />
          <motion.section
            role="dialog" aria-modal="true" aria-labelledby="model-picker-title"
            initial={reducedMotion ? { opacity: 0 } : mobile ? { y: "100%", opacity: 0.9 } : { y: 10, scale: 0.97, opacity: 0 }}
            animate={{ y: 0, scale: 1, opacity: 1 }}
            exit={reducedMotion ? { opacity: 0 } : mobile ? { y: "100%", opacity: 0.9 } : { y: 8, scale: 0.98, opacity: 0 }}
            transition={transitionFor(reducedMotion, MOMENTUM_SPRING)}
            drag={mobile && !reducedMotion ? "y" : false}
            dragControls={dragControls} dragListener={false} dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0.03, bottom: 0.3 }} dragMomentum={false} dragSnapToOrigin
            onDragEnd={(_, info) => {
              if (shouldDismissGesture({ offset: info.offset.y, velocity: info.velocity.y, size: Math.min(window.innerHeight * 0.75, 720), direction: "positive" })) onClose()
            }}
            className="fluid-material-strong relative flex h-[78dvh] w-full max-w-[46rem] flex-col overflow-hidden rounded-[1.35rem] border border-border/55 paper-grain dark:border-white/10 md:h-[min(78dvh,760px)] md:rounded-2xl"
          >
            <div onPointerDown={event => { if (mobile && !reducedMotion) dragControls.start(event) }} className="flex h-8 shrink-0 touch-none cursor-grab items-center justify-center active:cursor-grabbing md:hidden" aria-hidden="true"><div className="h-1 w-14 rounded-full bg-muted-foreground/30" /></div>
            <div className="relative flex h-14 shrink-0 items-center justify-center border-b border-border/45 px-4 dark:border-white/8">
              <h2 id="model-picker-title" className="text-[16px] font-medium tracking-tight text-foreground">选择模型</h2>
              <button onClick={onClose} className="fluid-press fluid-icon-press absolute right-2.5 flex size-11 items-center justify-center rounded-full border border-border/55 bg-background/85 text-muted-foreground hover:text-foreground dark:border-white/10 dark:bg-white/5" aria-label="关闭模型选择"><X className="size-4" /></button>
            </div>
            <div className="fluid-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-1.5 md:px-3">
              <EndpointList endpoints={endpoints} activeEndpointId={activeEndpointId} onSelect={onEndpointSelect ? endpoint => { onEndpointSelect(endpoint); onClose() } : undefined} />
              <ModelCatalogList models={baseModels} activeModelId={activeEndpointId ? null : activeModelId} onSelect={model => { onSelect(model); onClose() }} compact />
              {otherModels.length > 0 && <ModelGroupDivider models={otherModels} baseCount={baseModels.length} />}
              {otherModels.length > 0 && <ModelCatalogList models={otherModels} activeModelId={activeEndpointId ? null : activeModelId} onSelect={model => { onSelect(model); onClose() }} compact />}
            </div>
          </motion.section>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
