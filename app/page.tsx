import { LiteraryChat } from "@/components/literary-chat"

export default function Page() {
  const memoryAvailable = Boolean(process.env.MEMORY_BASE_URL?.trim())

  return <LiteraryChat memoryAvailable={memoryAvailable} />
}
