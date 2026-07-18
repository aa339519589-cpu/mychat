"use client"

import { FluidMotionProvider } from "@/components/fluid-motion-provider"
import { LiteraryChat } from "@/components/literary-chat"

export function MyChatApp() {
  return (
    <FluidMotionProvider>
      <LiteraryChat />
    </FluidMotionProvider>
  )
}
