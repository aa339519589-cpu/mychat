import type { Transition } from "motion/react"

export const UI_SPRING = {
  type: "spring",
  stiffness: 500,
  damping: 42,
  mass: 0.9,
} satisfies Transition

export const PANEL_SPRING = {
  type: "spring",
  stiffness: 420,
  damping: 38,
  mass: 0.95,
} satisfies Transition

export const MOMENTUM_SPRING = {
  type: "spring",
  stiffness: 390,
  damping: 32,
  mass: 0.9,
} satisfies Transition

export const POPOVER_SPRING = {
  type: "spring",
  stiffness: 540,
  damping: 40,
  mass: 0.75,
} satisfies Transition

export const REDUCED_MOTION_TRANSITION = {
  duration: 0.16,
  ease: "linear",
} satisfies Transition

export function transitionFor(
  reducedMotion: boolean | null,
  transition: Transition = UI_SPRING,
): Transition {
  return reducedMotion ? REDUCED_MOTION_TRANSITION : transition
}

export function projectMomentum(velocity: number, decelerationRate = 0.99) {
  if (decelerationRate <= 0 || decelerationRate >= 1) {
    throw new RangeError("decelerationRate must be between 0 and 1")
  }
  return (velocity / 1000) * decelerationRate / (1 - decelerationRate)
}

export function rubberband(overshoot: number, dimension: number, constant = 0.55) {
  if (dimension <= 0) return 0
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot))
}

export function shouldDismissGesture({
  offset,
  velocity,
  size,
  direction,
}: {
  offset: number
  velocity: number
  size: number
  direction: "negative" | "positive"
}) {
  const projected = offset + projectMomentum(velocity)
  const threshold = Math.max(44, size * 0.34)
  return direction === "negative" ? projected <= -threshold : projected >= threshold
}
