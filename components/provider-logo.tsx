"use client"

import Image from "next/image"
import { Image as ImageIcon, Sparkles } from "lucide-react"
import { cn } from "@/lib/utils"

const PROVIDER_LOGOS: Record<string, { src: string; monochrome?: boolean }> = {
  OpenAI: { src: "/provider-icons/openai.svg", monochrome: true },
  Anthropic: { src: "/provider-icons/claude-color.svg" },
  Google: { src: "/provider-icons/gemini-color.svg" },
  DeepSeek: { src: "/provider-icons/deepseek-color.svg" },
  MiniMax: { src: "/provider-icons/minimax-color.svg" },
  Moonshot: { src: "/provider-icons/kimi.svg", monochrome: true },
  "Z.ai": { src: "/provider-icons/zai.svg", monochrome: true },
  xAI: { src: "/provider-icons/grok.svg", monochrome: true },
}

export function ProviderLogo({
  provider,
  size = 28,
  className,
}: {
  provider: string
  size?: number
  className?: string
}) {
  const logo = PROVIDER_LOGOS[provider] ?? PROVIDER_LOGOS["Z.ai"]
  const dimension = `${size / 16}rem`
  return (
    <Image
      src={logo.src}
      alt=""
      width={size}
      height={size}
      priority
      loading="eager"
      fetchPriority="high"
      unoptimized
      aria-hidden="true"
      className={cn("object-contain", logo.monochrome && "dark:invert", className)}
      style={{ width: dimension, height: dimension }}
    />
  )
}

export function ProviderMark({
  provider,
  className,
}: {
  provider: string
  className?: string
}) {
  return (
    <span className={cn("flex size-9 shrink-0 items-center justify-center text-foreground", className)}>
      <ProviderLogo provider={provider} size={28} />
      <span className="sr-only">{provider}</span>
    </span>
  )
}

/** Compact mark for the chat composer model button. */
export function ComposerProviderIcon({
  provider,
  outputKind,
}: {
  provider?: string | null
  outputKind?: string | null
}) {
  if (outputKind === "image") {
    return <ImageIcon className="size-[1.15rem] shrink-0" aria-hidden="true" />
  }
  if (provider && PROVIDER_LOGOS[provider]) {
    return <ProviderLogo provider={provider} size={18} className="shrink-0" />
  }
  return <Sparkles className="size-[1.1rem] shrink-0" aria-hidden="true" />
}
