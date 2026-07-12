/**
 * Markdown helpers for chat rendering.
 * GFM tables need real newlines between rows; some models emit collapsed rows with `||`.
 */

const CODE_FENCE_RE = /(```[\s\S]*?```|~~~[\s\S]*?~~~)/g

/** Repair a single physical line that looks like a collapsed GFM table. */
function repairTableLine(line: string): string {
  // Must contain a GFM separator cell (|---|) and at least one row-boundary `||`.
  if (!/\|[\t ]*:?-{3,}/.test(line)) return line
  if (!line.includes("||")) return line
  // Prefer exact `||` (model collapse). Leave `| |` empty cells alone.
  return line.replace(/\|\|/g, "|\n|")
}

/**
 * Insert newlines between collapsed GFM table rows.
 * Does not touch fenced code blocks.
 */
export function repairCollapsedGfmTables(text: string): string {
  if (!text || !text.includes("|") || !text.includes("||")) return text

  return text
    .split(CODE_FENCE_RE)
    .map(part => {
      if (part.startsWith("```") || part.startsWith("~~~")) return part
      return part.split("\n").map(repairTableLine).join("\n")
    })
    .join("")
}

/** Full preprocess before react-markdown (math is applied separately in UI). */
export function prepareChatMarkdown(text: string): string {
  return repairCollapsedGfmTables(text)
}
