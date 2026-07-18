import { sanitizeArtifactSvg } from './artifact-security'

export type ArtifactKind = 'vega' | 'mermaid' | 'function-plot' | 'inline-artifact' | 'artifact'

export type ArtifactBlock = {
  kind: ArtifactKind
  raw: string
  done: boolean
}

export type ArtifactParsed = {
  display: string
  /** All renderable blocks in model-output order. */
  blocks: ArtifactBlock[]
  // 面板 artifact（需要自己的视觉环境，如红色立方体、复杂报告）
  raw: string | null
  done: boolean
  // 内联 SVG（纯矢量，手画坐标）
  inlineRaw: string | null
  inlineDone: boolean
  // Vega-Lite 图表（JSON spec，库负责画）
  vegaRaw: string | null
  vegaDone: boolean
  // Mermaid 流程图（mermaid 语法）
  mermaidRaw: string | null
  mermaidDone: boolean
  // Function-plot 数学函数（JSON spec）
  fnPlotRaw: string | null
  fnPlotDone: boolean
}

type ArtifactTag = {
  kind: ArtifactKind
  open: string
  close: string
}

type LegacyArtifactValue = {
  raw: string | null
  done: boolean
}

const ARTIFACT_TAGS: ArtifactTag[] = [
  { kind: 'vega', open: '<vega>', close: '</vega>' },
  { kind: 'mermaid', open: '<mermaid>', close: '</mermaid>' },
  { kind: 'function-plot', open: '<function-plot>', close: '</function-plot>' },
  { kind: 'inline-artifact', open: '<inline-artifact>', close: '</inline-artifact>' },
  { kind: 'artifact', open: '<artifact>', close: '</artifact>' },
]

const ARTIFACT_OPEN_TAGS = ARTIFACT_TAGS.map(tag => tag.open)
const EMPTY_LEGACY_ARTIFACT: LegacyArtifactValue = { raw: null, done: false }

function trimTrailingArtifactPrelude(text: string): string {
  const start = text.lastIndexOf('<')
  if (start === -1) return text
  const tail = text.slice(start)
  if (ARTIFACT_OPEN_TAGS.some(tag => tag.startsWith(tail))) {
    return text.slice(0, start).trimEnd()
  }
  return text
}

function nextArtifactTag(text: string, from: number): { tag: ArtifactTag; start: number } | null {
  let next: { tag: ArtifactTag; start: number } | null = null
  for (const tag of ARTIFACT_TAGS) {
    const start = text.indexOf(tag.open, from)
    if (start !== -1 && (!next || start < next.start)) next = { tag, start }
  }
  return next
}

function firstBlock(blocks: ArtifactBlock[], kind: ArtifactKind): ArtifactBlock | undefined {
  return blocks.find(block => block.kind === kind)
}

function legacyArtifactValue(blocks: ArtifactBlock[], kind: ArtifactKind): LegacyArtifactValue {
  const block = firstBlock(blocks, kind)
  if (!block) return EMPTY_LEGACY_ARTIFACT
  return { raw: block.raw, done: block.done }
}

function parsedResult(display: string, blocks: ArtifactBlock[]): ArtifactParsed {
  const panel = legacyArtifactValue(blocks, 'artifact')
  const inline = legacyArtifactValue(blocks, 'inline-artifact')
  const vega = legacyArtifactValue(blocks, 'vega')
  const mermaid = legacyArtifactValue(blocks, 'mermaid')
  const fnPlot = legacyArtifactValue(blocks, 'function-plot')

  return {
    display,
    blocks,
    raw: panel.raw,
    done: panel.done,
    inlineRaw: inline.raw,
    inlineDone: inline.done,
    vegaRaw: vega.raw,
    vegaDone: vega.done,
    mermaidRaw: mermaid.raw,
    mermaidDone: mermaid.done,
    fnPlotRaw: fnPlot.raw,
    fnPlotDone: fnPlot.done,
  }
}

export function parseArtifact(text: string): ArtifactParsed {
  const first = nextArtifactTag(text, 0)
  if (!first) return parsedResult(trimTrailingArtifactPrelude(text), [])

  const displayParts: string[] = []
  const blocks: ArtifactBlock[] = []
  let cursor = 0
  let next: { tag: ArtifactTag; start: number } | null = first

  while (next) {
    const before = text.slice(cursor, next.start).trim()
    if (before) displayParts.push(before)

    const bodyStart = next.start + next.tag.open.length
    const end = text.indexOf(next.tag.close, bodyStart)
    if (end === -1) {
      blocks.push({
        kind: next.tag.kind,
        raw: text.slice(bodyStart),
        done: false,
      })
      cursor = text.length
      break
    }

    blocks.push({
      kind: next.tag.kind,
      raw: text.slice(bodyStart, end).trim(),
      done: true,
    })
    cursor = end + next.tag.close.length
    next = nextArtifactTag(text, cursor)
  }

  if (cursor < text.length) {
    const trailing = trimTrailingArtifactPrelude(text.slice(cursor)).trim()
    if (trailing) displayParts.push(trailing)
  }

  return parsedResult(displayParts.join('\n\n'), blocks)
}

function readNumericAttr(tag: string, name: string): number | null {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*["']?([0-9.]+)`, 'i'))
  const n = m ? Number(m[1]) : NaN
  return Number.isFinite(n) && n > 0 ? n : null
}

function normalizeSvgRoot(svg: string): string {
  const match = svg.match(/<svg\b[^>]*>/i)
  if (!match) return svg

  const original = match[0]
  let next = original
  const width = readNumericAttr(original, 'width')
  const height = readNumericAttr(original, 'height')

  // 很多模型会输出固定 width/height/style，手机端会被撑爆。
  // 如果没有 viewBox，先用原 width/height 补一个，再移除固定尺寸，让前端按容器自适应。
  if (!/\sviewBox\s*=/i.test(next) && width && height) {
    next = next.replace(/<svg\b/i, `<svg viewBox="0 0 ${width} ${height}"`)
  }

  if (!/\sxmlns\s*=/i.test(next)) {
    next = next.replace(/<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"')
  }

  next = next
    .replace(/\s(width|height)\s*=\s*"[^"]*"/gi, '')
    .replace(/\s(width|height)\s*=\s*'[^']*'/gi, '')
    .replace(/\s(width|height)\s*=\s*[^\s>]+/gi, '')
    .replace(/\sstyle\s*=\s*"[^"]*"/gi, '')
    .replace(/\sstyle\s*=\s*'[^']*'/gi, '')
    .replace(/\sstyle\s*=\s*[^\s>]+/gi, '')

  return svg.replace(original, next)
}

// 从内联内容里提取并安全清洗 SVG，直接注入对话 DOM 渲染
// - 流式时若未闭合，临时补 </svg> 让浏览器容错渲染
// - 通过严格 SVG allowlist 去掉脚本、外部资源、事件和危险命名空间
// - 归一化根 SVG：保留 viewBox，移除固定宽高，避免手机端被大图撑爆
export function sanitizeSvg(input: string): string | null {
  if (!input) return null
  const open = input.search(/<svg[\s>]/i)
  if (open === -1) return null

  let svg: string
  const closeMatch = input.match(/<\/svg\s*>/i)
  if (closeMatch && typeof closeMatch.index === 'number') {
    svg = input.slice(open, closeMatch.index + closeMatch[0].length)
  } else {
    svg = input.slice(open) + '</svg>'
  }

  const sanitized = sanitizeArtifactSvg(svg)
  return sanitized.includes('<svg') ? normalizeSvgRoot(sanitized) : null
}

// 从 artifact HTML 里猜标题，给对话流卡片入口用
export function artifactTitle(raw: string): string {
  const t = raw.match(/<title[^>]*>([^<]+)<\/title>/i)
  if (t?.[1]?.trim()) return t[1].trim().slice(0, 40)
  const h = raw.match(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i)
  if (h?.[1]) {
    const plain = h[1].replace(/<[^>]+>/g, '').trim()
    if (plain) return plain.slice(0, 40)
  }
  return '渲染结果'
}
