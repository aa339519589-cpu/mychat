"use client"

import type { ComponentType, PointerEvent as ReactPointerEvent } from "react"
import { AnimatePresence, motion, useDragControls, useReducedMotion } from "motion/react"
import { ArtifactPanel } from "@/components/artifact-panel"
import type { ArtifactLibraryOverlayProps } from "@/components/artifact-library-overlay"
import type { CodeConsoleProps } from "@/components/code-console"
import { artifactTitle, type ArtifactParsed } from "@/lib/artifact"
import { PANEL_SPRING, shouldDismissGesture, transitionFor } from "@/components/motion/fluid"
import type { LiteraryChatLayoutState } from "./layout-state"

type ViewOverlaysProps = {
  sessionUserId: string
  layout: LiteraryChatLayoutState
  mobile: boolean
  artifact: ArtifactParsed | null
  artifactPanelWidth: number
  codeConsole: ComponentType<CodeConsoleProps>
  artifactLibrary: ComponentType<ArtifactLibraryOverlayProps>
}

export function ViewOverlays(props: ViewOverlaysProps) {
  const { layout, artifact, mobile, artifactPanelWidth, codeConsole, artifactLibrary } = props
  return (
    <>
      <CodeConsoleOverlay open={layout.codeOpen} userId={props.sessionUserId} component={codeConsole} onExit={() => layout.setCodeOpen(false)} />
      <ArtifactLibraryOverlay open={layout.artifactLibraryOpen} component={artifactLibrary} onClose={() => layout.setArtifactLibraryOpen(false)} />
      <ArtifactOverlay
        artifact={artifact}
        mobile={mobile}
        width={artifactPanelWidth}
        openId={layout.openArtifactId}
        onClose={() => layout.setOpenArtifactId(null)}
      />
    </>
  )
}

function CodeConsoleOverlay({ open, userId, component: CodeConsole, onExit }: { open: boolean; userId: string; component: ComponentType<CodeConsoleProps>; onExit: () => void }) {
  const reducedMotion = useReducedMotion()
  return (
    <AnimatePresence initial={false}>
      {open && <motion.div key="code-console" initial={reducedMotion ? { opacity: 0 } : { opacity: 0, x: -24, scale: 0.99 }} animate={{ opacity: 1, x: 0, scale: 1 }} exit={reducedMotion ? { opacity: 0 } : { opacity: 0, x: -24, scale: 0.99 }} transition={transitionFor(reducedMotion, PANEL_SPRING)} className="fixed inset-0 z-[60]"><CodeConsole userId={userId} onExit={onExit} /></motion.div>}
    </AnimatePresence>
  )
}

function ArtifactLibraryOverlay({ open, component: Library, onClose }: { open: boolean; component: ComponentType<ArtifactLibraryOverlayProps>; onClose: () => void }) {
  return <AnimatePresence initial={false}>{open && <Library key="artifact-library" open onClose={onClose} />}</AnimatePresence>
}

function ArtifactOverlay({ artifact, mobile, width, openId, onClose }: { artifact: ArtifactParsed | null; mobile: boolean; width: number; openId: string | null; onClose: () => void }) {
  const dragControls = useDragControls()
  const reducedMotion = useReducedMotion()
  return (
    <AnimatePresence initial={false} mode="popLayout">
      {artifact?.raw && <motion.aside
        key={openId}
        initial={reducedMotion ? { opacity: 0 } : mobile ? { x: "100%", opacity: 0.92 } : { width: 0, opacity: 0, marginLeft: 0 }}
        animate={mobile ? { x: 0, opacity: 1 } : { width, opacity: 1, marginLeft: 8 }}
        exit={reducedMotion ? { opacity: 0 } : mobile ? { x: "100%", opacity: 0.9 } : { width: 0, opacity: 0, marginLeft: 0 }}
        transition={transitionFor(reducedMotion, PANEL_SPRING)}
        drag={mobile && !reducedMotion ? "x" : false}
        dragControls={dragControls}
        dragListener={false}
        dragConstraints={{ left: 0, right: 0 }}
        dragElastic={{ left: 0.04, right: 0.34 }}
        dragMomentum={false}
        dragSnapToOrigin
        onDragEnd={(_, info) => {
          if (shouldDismissGesture({ offset: info.offset.x, velocity: info.velocity.x, size: window.innerWidth, direction: "positive" })) onClose()
        }}
        className="fixed inset-0 z-50 overflow-hidden bg-background md:relative md:inset-auto md:z-auto md:min-w-0 md:shrink-0 md:rounded-2xl md:border md:border-border/50"
      >
        <ArtifactPanel raw={artifact.raw} done={artifact.done} title={artifactTitle(artifact.raw)} onClose={onClose} onDragStart={event => startArtifactDrag(event, mobile, reducedMotion, dragControls)} />
      </motion.aside>}
    </AnimatePresence>
  )
}

function startArtifactDrag(event: ReactPointerEvent, mobile: boolean, reducedMotion: boolean | null, controls: ReturnType<typeof useDragControls>) {
  if (mobile && !reducedMotion) controls.start(event)
}
