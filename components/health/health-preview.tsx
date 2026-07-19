"use client"

import { useRouter } from "next/navigation"
import { HealthWorkspace } from "./health-workspace"

export function HealthPreview() {
  const router = useRouter()
  return <HealthWorkspace open onClose={() => router.push("/")} />
}
