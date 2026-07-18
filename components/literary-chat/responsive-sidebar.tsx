"use client"

import { useEffect, useRef, useState, type ComponentProps, type PointerEvent as ReactPointerEvent } from "react"
import { animate, motion, useMotionValue, useReducedMotion, useTransform } from "motion/react"
import { AppSidebar } from "@/components/app-sidebar"
import { MOMENTUM_SPRING, PANEL_SPRING, rubberband, shouldDismissGesture, transitionFor } from "@/components/motion/fluid"
import type { LiteraryChatLayoutState } from "./layout-state"

type ResponsiveSidebarProps = {
  layout: LiteraryChatLayoutState
  sidebar: ComponentProps<typeof AppSidebar>
  mobile: boolean
}

type Gesture = {
  pointerId: number
  startX: number
  originX: number
  history: Array<{ x: number; time: number }>
}

function clippedOffset(raw: number, width: number) {
  if (raw > 0) return rubberband(raw, width)
  if (raw < -width) return -width - rubberband(-width - raw, width)
  return raw
}

function gestureVelocity(gesture: Gesture, cancelled: boolean) {
  if (cancelled) return 0
  const first = gesture.history[0]
  const last = gesture.history.at(-1) ?? first
  return (last.x - first.x) / Math.max(1, last.time - first.time) * 1000
}

function useDrawerMotion(layout: LiteraryChatLayoutState, mobile: boolean) {
  const drawerRef = useRef<HTMLDivElement>(null)
  const animationRef = useRef<ReturnType<typeof animate> | null>(null)
  const gestureRef = useRef<Gesture | null>(null)
  const drawerX = useMotionValue(-320)
  const [drawerWidth, setDrawerWidth] = useState(320)
  const reducedMotion = useReducedMotion()
  const scrimOpacity = useTransform(drawerX, [-drawerWidth, 0], [0, 1])

  useEffect(() => {
    const drawer = drawerRef.current
    if (!drawer) return
    const update = () => setDrawerWidth(drawer.getBoundingClientRect().width || 320)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(drawer)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    animationRef.current?.stop()
    const target = mobile && !layout.drawerOpen ? -drawerWidth : 0
    animationRef.current = animate(drawerX, target, transitionFor(reducedMotion, PANEL_SPRING))
    return () => animationRef.current?.stop()
  }, [drawerWidth, drawerX, layout.drawerOpen, mobile, reducedMotion])

  const settle = (offset: number, velocity: number) => {
    if (shouldDismissGesture({ offset, velocity, size: drawerWidth, direction: "negative" })) {
      layout.setDrawerOpen(false)
      return
    }
    animationRef.current?.stop()
    animationRef.current = animate(drawerX, 0, reducedMotion ? transitionFor(true) : { ...MOMENTUM_SPRING, velocity })
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!mobile || !layout.drawerOpen) return
    animationRef.current?.stop()
    event.currentTarget.setPointerCapture(event.pointerId)
    gestureRef.current = { pointerId: event.pointerId, startX: event.clientX, originX: drawerX.get(), history: [{ x: event.clientX, time: event.timeStamp }] }
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) return

    const nextX = clippedOffset(gesture.originX + event.clientX - gesture.startX, drawerWidth)
    if (Math.abs(nextX - drawerX.get()) >= 0.1) drawerX.set(nextX)

    const history = gesture.history
    history.push({ x: event.clientX, time: event.timeStamp })
    const cutoff = event.timeStamp - 100
    while (history.length > 1 && (history[0].time < cutoff || history.length > 8)) history.shift()
  }

  const onPointerEnd = (event: ReactPointerEvent<HTMLDivElement>, cancelled = false) => {
    const gesture = gestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    gestureRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    settle(cancelled ? 0 : drawerX.get(), gestureVelocity(gesture, cancelled))
  }

  return { drawerRef, drawerX, scrimOpacity, onPointerDown, onPointerMove, onPointerEnd, reducedMotion }
}

export function ResponsiveSidebar({ layout, sidebar, mobile }: ResponsiveSidebarProps) {
  const drawer = useDrawerMotion(layout, mobile)
  return (
    <motion.div
      data-testid="responsive-sidebar-layer"
      initial={false}
      animate={{ "--sidebar-width": layout.sidebarCollapsed ? "0px" : "320px" }}
      transition={transitionFor(drawer.reducedMotion, PANEL_SPRING)}
      aria-hidden={mobile && !layout.drawerOpen}
      className={layout.drawerOpen ? "fixed inset-0 z-40 w-full shrink-0 md:relative md:inset-auto md:z-auto md:h-full md:w-[var(--sidebar-width)] md:overflow-hidden" : "pointer-events-none fixed inset-0 z-40 w-full shrink-0 md:pointer-events-auto md:relative md:inset-auto md:z-auto md:h-full md:w-[var(--sidebar-width)] md:overflow-hidden"}
    >
      <motion.button
        type="button"
        aria-label="收起侧栏"
        onClick={() => layout.setDrawerOpen(false)}
        style={{ opacity: drawer.scrimOpacity, willChange: "opacity" }}
        className="absolute inset-0 bg-black/42 md:hidden"
      />
      <motion.div
        data-testid="responsive-sidebar-drawer"
        ref={drawer.drawerRef}
        role={mobile ? "dialog" : undefined}
        aria-modal={mobile || undefined}
        aria-label={mobile ? "对话与工作区导航" : undefined}
        inert={mobile && !layout.drawerOpen}
        style={{ x: drawer.drawerX, willChange: "transform", backfaceVisibility: "hidden" }}
        className="fluid-drag-surface relative h-full w-[min(20rem,82vw)] overflow-hidden bg-sidebar shadow-2xl md:w-[20rem] md:!transform-none md:border-r md:border-border/50 md:shadow-none"
      >
        <AppSidebar {...sidebar} visible={mobile ? layout.drawerOpen : true} onClose={() => layout.setDrawerOpen(false)} onDragStart={drawer.onPointerDown} onDragMove={drawer.onPointerMove} onDragEnd={event => drawer.onPointerEnd(event)} onDragCancel={event => drawer.onPointerEnd(event, true)} />
      </motion.div>
    </motion.div>
  )
}
