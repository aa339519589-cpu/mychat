import { notFound } from "next/navigation"
import { HealthPreview } from "@/components/health/health-preview"

export default function HealthPreviewPage() {
  if (process.env.NODE_ENV === "production") notFound()
  return <HealthPreview />
}
