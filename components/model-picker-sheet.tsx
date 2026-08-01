"use client"

import { useEffect } from "react"
import { AnimatePresence, motion, useDragControls, useReducedMotion } from "motion/react"
import { X } from "lucide-react"

import { ModelCatalogList } from "@/components/model-catalog-list"
import { MOMENTUM_SPRING, shouldDismissGesture, transitionFor } from "@/components/motion/fluid"
import type { ModelCatalogItem } from "@/lib/model-catalog"
import { cn } from "@/lib/utils"

function ModelGroupDivider({ models }: { models: ModelCatalogItem[] }) {
  const sample = models.find(model => model.access === "trial")
  const limit = typeof sample?.trialLimit === "number" ? sample.trialLimit : 3
  const remaining = typeof sample?.trialRemaining === "number" ? sample.trialRemaining : null
  const unlimited = sample?.trialUnlimited === true
  return (
    <div className="px-3 py-3.5">
      <div className="flex items-center gap-2.5">
        <span className="h-px flex-1 bg-border/70 dark:bg-white/10" />
        <span className="shrink-0 text-[11px] font-medium tracking-[0.04em] text-foreground/80">以上 3 个为基础模型</span>
        <span className="h-px flex-1 bg-border/70 dark:bg-white/10" />
      </div>
      <p className={cn("mt-2 text-center text-[11px]", remaining === 0 ? "font-medium text-destructive" : "text-muted-foreground")}>
        {unlimited
          ? "会员账户：其他模型不限次数"
          : remaining === null
            ? `其他可试用模型共享 ${limit} 次额度`
            : remaining === 0
              ? "其他可试用模型额度已用完 · 剩余 0 次"
              : `其他可试用模型共享额度 · 剩余 ${remaining} / ${limit} 次`}
      </p>
    </div>
  )
}

export function ModelPickerSheet({ open, mobile, models, activeModelId, onClose, onSelect }: {
  open: boolean
  mobile: boolean
  models: ModelCatalogItem[]
  activeModelId: string | null
  onClose: () => void
  onSelect: (model: ModelCatalogItem) => void
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
              <ModelCatalogList models={baseModels} activeModelId={activeModelId} onSelect={model => { onSelect(model); onClose() }} compact />
              {otherModels.length > 0 && <ModelGroupDivider models={otherModels} />}
              {otherModels.length > 0 && <ModelCatalogList models={otherModels} activeModelId={activeModelId} onSelect={model => { onSelect(model); onClose() }} compact />}
            </div>
          </motion.section>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
