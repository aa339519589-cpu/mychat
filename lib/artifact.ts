export type ArtifactParsed = {
  display: string
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

const EMPTY: ArtifactParsed = {
  display: '', raw: null, done: false,
  inlineRaw: null, inlineDone: false,
  vegaRaw: null, vegaDone: false,
  mermaidRaw: null, mermaidDone: false,
  fnPlotRaw: null, fnPlotDone: false,
}

function parseTag(text: string, open: string, close: string): { before: string; body: string; after: string; closed: boolean } | null {
  const start = text.indexOf(open)
  if (start === -1) return null
  const bodyStart = start + open.length
  const end = text.indexOf(close, bodyStart)
  if (end === -1) {
    return { before: text.slice(0, start).trim(), body: text.slice(bodyStart), after: '', closed: false }
  }
  return {
    before: text.slice(0, start).trim(),
    body: text.slice(bodyStart, end).trim(),
    after: text.slice(end + close.length).trim(),
    closed: true,
  }
}

export function parseArtifact(text: string): ArtifactParsed {
  // 优先级：vega → mermaid → function-plot → inline-artifact → artifact

  const vega = parseTag(text, '<vega>', '</vega>')
  if (vega) {
    const display = [vega.before, vega.closed ? vega.after : ''].filter(Boolean).join('\n\n')
    return { ...EMPTY, display, vegaRaw: vega.body, vegaDone: vega.closed }
  }

  const mermaid = parseTag(text, '<mermaid>', '</mermaid>')
  if (mermaid) {
    const display = [mermaid.before, mermaid.closed ? mermaid.after : ''].filter(Boolean).join('\n\n')
    return { ...EMPTY, display, mermaidRaw: mermaid.body, mermaidDone: mermaid.closed }
  }

  const fnPlot = parseTag(text, '<function-plot>', '</function-plot>')
  if (fnPlot) {
    const display = [fnPlot.before, fnPlot.closed ? fnPlot.after : ''].filter(Boolean).join('\n\n')
    return { ...EMPTY, display, fnPlotRaw: fnPlot.body, fnPlotDone: fnPlot.closed }
  }

  const inline = parseTag(text, '<inline-artifact>', '</inline-artifact>')
  if (inline) {
    const display = [inline.before, inline.closed ? inline.after : ''].filter(Boolean).join('\n\n')
    return { ...EMPTY, display, inlineRaw: inline.body, inlineDone: inline.closed }
  }

  const panel = parseTag(text, '<artifact>', '</artifact>')
  if (panel) {
    const display = [panel.before, panel.closed ? panel.after : ''].filter(Boolean).join('\n\n')
    return { ...EMPTY, display, raw: panel.body, done: panel.closed }
  }

  return { ...EMPTY, display: text }
}

// 从内联内容里提取并安全清洗 SVG，直接注入对话 DOM 渲染
// - 流式时若未闭合，临时补 </svg> 让浏览器容错渲染
// - 去掉 script / foreignObject / on* 事件 / javascript: 协议，防 XSS
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

  svg = svg
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<script[\s\S]*$/gi, '')
    .replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, '')
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '')
    .replace(/(xlink:href|href)\s*=\s*"\s*javascript:[^"]*"/gi, '')
    .replace(/(xlink:href|href)\s*=\s*'\s*javascript:[^']*'/gi, '')

  return svg
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
