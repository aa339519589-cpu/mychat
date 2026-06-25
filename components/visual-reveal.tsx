"use client"

import { useEffect, useRef, useState, type ReactNode } from "react"
import { cn } from "@/lib/utils"

export function VisualReveal({
  ready,
  signature,
  className,
  contentClassName,
  children,
}: {
  ready: boolean
  signature: string
  className?: string
  contentClassName?: string
  children: ReactNode
}) {
  const [revealed, setRevealed] = useState(false)
  const rafA = useRef<number | null>(null)
  const rafB = useRef<number | null>(null)

  useEffect(() => {
    if (rafA.current !== null) cancelAnimationFrame(rafA.current)
    if (rafB.current !== null) cancelAnimationFrame(rafB.current)

    if (!ready) {
      setRevealed(false)
      return
    }

    setRevealed(false)
    rafA.current = requestAnimationFrame(() => {
      rafB.current = requestAnimationFrame(() => {
        setRevealed(true)
        rafA.current = null
        rafB.current = null
      })
    })

    return () => {
      if (rafA.current !== null) cancelAnimationFrame(rafA.current)
      if (rafB.current !== null) cancelAnimationFrame(rafB.current)
      rafA.current = null
      rafB.current = null
    }
  }, [ready, signature])

  return (
    <div
      className={cn("visual-reveal", className)}
      data-ready={ready ? "true" : "false"}
      data-revealed={revealed ? "true" : "false"}
    >
      <div className={cn("visual-reveal__content", contentClassName)}>
        {children}
      </div>
      <div className="visual-reveal__veil" aria-hidden="true" />
    </div>
  )
}
