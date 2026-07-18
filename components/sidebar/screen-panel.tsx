"use client"

import { type CSSProperties, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { motion, useReducedMotion } from "motion/react"
import { ChevronLeft } from "lucide-react"

import { PANEL_SPRING, shouldDismissGesture, transitionFor } from "@/components/motion/fluid"
import { useMediaQuery } from "@/components/literary-chat/use-media-query"

export function ScreenPanel({ open, style, title, onBack, action, children }: {
  open: boolean
  style: CSSProperties
  title: ReactNode
  onBack: () => void
  action?: ReactNode
  children: ReactNode
}) {
  const reducedMotion = useReducedMotion()
  const mobile = useMediaQuery("(max-width: 767px)")
  const canSwipeBack = useMediaQuery("(max-width: 767px) and (pointer: coarse)")
  const panelStyle = mobile
    ? { ...style, zIndex: 70 + Number(style.zIndex ?? 0) }
    : style

  const panel = (
    <motion.div
      initial={false}
      animate={reducedMotion
        ? { x: 0, opacity: open ? 1 : 0 }
        : { x: open ? 0 : "100%", opacity: 1 }}
      transition={transitionFor(reducedMotion, PANEL_SPRING)}
      drag={open && canSwipeBack && !reducedMotion ? "x" : false}
      dragConstraints={{ left: 0, right: 0 }}
      dragElastic={{ left: 0, right: 0.34 }}
      dragDirectionLock
      dragMomentum={false}
      dragSnapToOrigin
      onDragEnd={(_, info) => {
        if (shouldDismissGesture({
          offset: info.offset.x,
          velocity: info.velocity.x,
          size: window.innerWidth,
          direction: "positive",
        })) onBack()
      }}
      aria-hidden={!open}
      inert={!open}
      className={mobile
        ? "fluid-drag-surface fixed inset-0 flex h-[100dvh] w-screen flex-col overflow-hidden bg-sidebar"
        : "fluid-drag-surface absolute inset-0 flex flex-col bg-sidebar"}
      style={panelStyle}
    >
      <div className="flex shrink-0 items-center gap-2 px-4 pb-4 pt-[max(1rem,env(safe-area-inset-top))]">
        <button onClick={onBack} className="fluid-press fluid-icon-press fluid-touch-target -ml-1 flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-sidebar-accent hover:text-foreground" aria-label="返回">
          <ChevronLeft className="size-5" />
        </button>
        <div className="min-w-0 flex-1">
          {typeof title === "string"
            ? <h3 className="truncate text-[16px] font-semibold tracking-tight">{title}</h3>
            : title}
        </div>
        {action}
      </div>
      <div className="fluid-scroll flex-1 overflow-y-auto pb-[max(1.5rem,env(safe-area-inset-bottom))]">{children}</div>
    </motion.div>
  )

  return mobile ? createPortal(panel, document.body) : panel
}
