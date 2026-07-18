"use client"

import type { ReactNode } from "react"
import { MotionConfig } from "motion/react"

import { UI_SPRING } from "@/components/motion/fluid"

export function FluidMotionProvider({ children }: { children: ReactNode }) {
  return (
    <MotionConfig reducedMotion="user" transition={UI_SPRING}>
      {children}
    </MotionConfig>
  )
}
