import Image from "next/image"

import { cn } from "@/lib/utils"

type CompanionAvatarProps = {
  size?: number
  className?: string
  imageClassName?: string
  eager?: boolean
}

export function CompanionAvatar({ size = 44, className, imageClassName, eager = false }: CompanionAvatarProps) {
  return (
    <span className={cn("companion-avatar inline-flex shrink-0 overflow-hidden", className)} aria-hidden="true">
      <Image
        src="/companion.png"
        alt=""
        width={size}
        height={size}
        priority={eager}
        draggable={false}
        className={cn("companion-avatar-img companion-avatar-light select-none", imageClassName)}
      />
      <Image
        src="/companion-dark.png"
        alt=""
        width={size}
        height={size}
        priority={eager}
        draggable={false}
        className={cn("companion-avatar-img companion-avatar-dark select-none", imageClassName)}
      />
    </span>
  )
}
