const CODE_PART_RE = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/g

function normalizeMathPart(text: string): string {
  return text
    .replace(/\\\[([\s\S]*?)\\\]/g, (_match, body: string) => `$$\n${body.trim()}\n$$`)
    .replace(/\\\(([\s\S]*?)\\\)/g, (_match, body: string) => `$${body.trim()}$`)
}

export function normalizeMathDelimiters(text: string): string {
  if (!text) return text
  return text
    .split(CODE_PART_RE)
    .map(part => part.startsWith('`') || part.startsWith('~~~') ? part : normalizeMathPart(part))
    .join('')
}
