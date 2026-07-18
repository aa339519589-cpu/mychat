"use client"

import { useEffect, type ReactNode } from "react"
import { AnimatePresence, motion, useDragControls, useReducedMotion } from "motion/react"
import { Check, Image as ImageIcon, Server, Video, X } from "lucide-react"

import { MODEL_SHEET_TIERS, TIER_MAP } from "@/lib/chat-data"
import type { ModelEndpointSummary } from "@/lib/model-endpoints"
import { cn } from "@/lib/utils"
import { MOMENTUM_SPRING, shouldDismissGesture, transitionFor } from "@/components/motion/fluid"

export function ModelPickerSheet({
  open,
  mobile,
  activeTier,
  activeEndpointId,
  endpoints,
  onClose,
  onSelectTier,
  onSelectEndpoint,
}: {
  open: boolean
  mobile: boolean
  activeTier: string
  activeEndpointId: string | null
  endpoints: ModelEndpointSummary[]
  onClose: () => void
  onSelectTier: (tier: string) => void
  onSelectEndpoint: (endpointId: string) => void
}) {
  const dragControls = useDragControls()
  const reducedMotion = useReducedMotion()

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose()
    }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [onClose, open])

  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          key="model-picker"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={transitionFor(reducedMotion)}
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/42 px-2 pb-2 pt-12 backdrop-blur-[2px] md:items-center md:p-4"
        >
          <button className="absolute inset-0 cursor-default" aria-label="关闭模型选择" onClick={onClose} />
          <ModelPickerSurface
            mobile={mobile}
            reducedMotion={reducedMotion}
            dragControls={dragControls}
            activeTier={activeTier}
            activeEndpointId={activeEndpointId}
            endpoints={endpoints}
            onClose={onClose}
            onSelectTier={onSelectTier}
            onSelectEndpoint={onSelectEndpoint}
          />
        </motion.div>
      )}
    </AnimatePresence>
  )
}

type PickerSurfaceProps = {
  mobile: boolean
  reducedMotion: boolean | null
  dragControls: ReturnType<typeof useDragControls>
  activeTier: string
  activeEndpointId: string | null
  endpoints: ModelEndpointSummary[]
  onClose: () => void
  onSelectTier: (tier: string) => void
  onSelectEndpoint: (endpointId: string) => void
}

function ModelPickerSurface(props: PickerSurfaceProps) {
  const { mobile, reducedMotion, dragControls, onClose } = props
  return (
    <motion.section
      role="dialog" aria-modal="true" aria-labelledby="model-picker-title"
      initial={reducedMotion ? { opacity: 0 } : mobile ? { y: "100%", opacity: 0.88 } : { y: 10, scale: 0.96, opacity: 0 }}
      animate={{ y: 0, scale: 1, opacity: 1 }}
      exit={reducedMotion ? { opacity: 0 } : mobile ? { y: "100%", opacity: 0.88 } : { y: 8, scale: 0.97, opacity: 0 }}
      transition={transitionFor(reducedMotion, MOMENTUM_SPRING)}
      drag={mobile && !reducedMotion ? "y" : false}
      dragControls={dragControls} dragListener={false} dragConstraints={{ top: 0, bottom: 0 }}
      dragElastic={{ top: 0.04, bottom: 0.34 }} dragMomentum={false} dragSnapToOrigin
      onDragEnd={(_, info) => {
        if (shouldDismissGesture({ offset: info.offset.y, velocity: info.velocity.y, size: Math.min(window.innerHeight * 0.5, 460), direction: "positive" })) onClose()
      }}
      className="fluid-material-strong relative flex h-[min(50dvh,460px)] w-full max-w-[42rem] flex-col overflow-hidden rounded-[1.5rem] border border-border/50 paper-grain dark:border-white/10 md:max-h-[500px] md:rounded-2xl"
    >
      <div
        onPointerDown={event => { if (mobile && !reducedMotion) dragControls.start(event) }}
        className="flex h-11 shrink-0 touch-none cursor-grab items-center justify-center active:cursor-grabbing md:hidden"
        aria-hidden="true"
      ><div className="h-1 w-16 rounded-full bg-muted-foreground/35" /></div>
      <div className="flex h-12 shrink-0 items-center justify-center px-4">
        <h2 id="model-picker-title" className="text-[16px] font-[750] tracking-normal text-foreground">选择模型</h2>
        <button onClick={onClose} className="fluid-press fluid-icon-press absolute right-3 flex size-11 items-center justify-center rounded-full border border-border/50 bg-secondary/70 text-muted-foreground shadow-sm hover:text-foreground dark:border-white/10 dark:bg-[#151515]">
          <X className="size-4" />
        </button>
      </div>
      <ModelRows {...props} />
    </motion.section>
  )
}

function ModelRows({ activeTier, activeEndpointId, endpoints, onSelectTier, onSelectEndpoint }: PickerSurfaceProps) {
  return (
    <div className="min-h-0 flex-1 px-4 pb-4">
      <div className="h-full overflow-hidden rounded-xl bg-card/70 dark:bg-[#151515]">
        <div className="fluid-scroll max-h-full overflow-y-auto">
          {MODEL_SHEET_TIERS.map((id, index) => {
            const config = TIER_MAP[id]
            const icon = config.media === "image" ? <ImageIcon className="size-4" /> : config.media === "video" ? <Video className="size-4" /> : undefined
            return <ModelRow key={id} label={config.label} icon={icon} active={!activeEndpointId && activeTier === id} divided={index > 0} onClick={() => onSelectTier(id)} />
          })}
          {endpoints.map((endpoint, index) => (
            <ModelRow
              key={endpoint.id} label={endpoint.name || endpoint.model}
              desc={`${endpoint.outputKind === "image" ? "图片" : endpoint.outputKind === "video" ? "视频" : "对话"} · ${endpoint.model}`}
              icon={endpoint.outputKind === "image" ? <ImageIcon className="size-4" /> : endpoint.outputKind === "video" ? <Video className="size-4" /> : <Server className="size-4" />}
              active={activeEndpointId === endpoint.id} divided={MODEL_SHEET_TIERS.length > 0 || index > 0}
              onClick={() => onSelectEndpoint(endpoint.id)}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

function ModelRow({
  label,
  desc,
  icon,
  active,
  divided,
  onClick,
}: {
  label: string
  desc?: string
  icon?: ReactNode
  active?: boolean
  divided?: boolean
  onClick: () => void
}) {
  return (
    <div className={cn("flex min-h-12 min-w-0 items-center gap-2 px-4 py-2.5", divided && "border-t border-border/40 dark:border-white/10")}>
      {icon && <span className="shrink-0 text-muted-foreground">{icon}</span>}
      <button onClick={onClick} className="fluid-press min-h-11 min-w-0 flex-1 rounded-lg text-left">
        <div className={cn("truncate text-[15px] font-[750] tracking-normal", active ? "text-foreground" : "text-foreground/92")}>{label}</div>
        {desc && <div className="mt-0.5 truncate text-[11px] font-[625] text-muted-foreground">{desc}</div>}
      </button>
      {active && <Check className="size-5 shrink-0 text-primary" />}
    </div>
  )
}
