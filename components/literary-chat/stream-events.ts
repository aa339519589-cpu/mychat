export type ParsedSseEvent =
  | { kind: "done" }
  | { kind: "data"; data: unknown }

export function splitSseEvents(buffer: string): { events: string[]; rest: string } {
  const normalized = buffer.replace(/\r\n/g, "\n")
  const parts = normalized.split("\n\n")
  return { events: parts.slice(0, -1), rest: parts.at(-1) ?? "" }
}

export function parseSseEvent(event: string): ParsedSseEvent | null {
  const payload = event
    .split("\n")
    .filter(line => line.startsWith("data:"))
    .map(line => line.slice(5).trimStart())
    .join("\n")

  if (!payload) return null
  if (payload === "[DONE]") return { kind: "done" }

  try {
    return { kind: "data", data: JSON.parse(payload) }
  } catch {
    return null
  }
}
