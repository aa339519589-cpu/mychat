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
}

export function parseArtifact(text: string): ArtifactParsed {
  // 先尝试 <vega>
  const VO = text.indexOf('<vega>')
  if (VO !== -1) {
    const before = text.slice(0, VO).trim()
    const bodyStart = VO + '<vega>'.length
    const VC = text.indexOf('</vega>', bodyStart)
    if (VC === -1) {
      return { display: before, raw: null, done: false, inlineRaw: null, inlineDone: false, vegaRaw: text.slice(bodyStart), vegaDone: false }
    }
    const vegaRaw = text.slice(bodyStart, VC).trim()
    const after = text.slice(VC + '</vega>'.length).trim()
    return { display: [before, after].filter(Boolean).join('\n\n'), raw: null, done: false, inlineRaw: null, inlineDone: false, vegaRaw, vegaDone: true }
  }

  // 再尝试 inline-artifact
  const IO = text.indexOf('<inline-artifact>')
  if (IO !== -1) {
    const before = text.slice(0, IO).trim()
    const bodyStart = IO + '<inline-artifact>'.length
    const IC = text.indexOf('</inline-artifact>', bodyStart)
    if (IC === -1) {
      return { display: before, raw: null, done: false, inlineRaw: text.slice(bodyStart), inlineDone: false, vegaRaw: null, vegaDone: false }
    }
    const inlineRaw = text.slice(bodyStart, IC).trim()
    const after = text.slice(IC + '</inline-artifact>'.length).trim()
    return { display: [before, after].filter(Boolean).join('\n\n'), raw: null, done: false, inlineRaw, inlineDone: true, vegaRaw: null, vegaDone: false }
  }

  // 最后尝试 panel artifact
  const O = text.indexOf('<artifact>')
  if (O === -1) return { display: text, raw: null, done: false, inlineRaw: null, inlineDone: false, vegaRaw: null, vegaDone: false }
  const before = text.slice(0, O).trim()
  const bodyStart = O + '<artifact>'.length
  const C = text.indexOf('</artifact>', bodyStart)
  if (C === -1) {
    return { display: before, raw: text.slice(bodyStart), done: false, inlineRaw: null, inlineDone: false, vegaRaw: null, vegaDone: false }
  }
  const raw = text.slice(bodyStart, C).trim()
  const after = text.slice(C + '</artifact>'.length).trim()
  return { display: [before, after].filter(Boolean).join('\n\n'), raw, done: true, inlineRaw: null, inlineDone: false, vegaRaw: null, vegaDone: false }
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
    // 流式中还没闭合：取到末尾并补一个闭合标签
    svg = input.slice(open) + '</svg>'
  }

  svg = svg
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<script[\s\S]*$/gi, '')           // 流式中未闭合的 script 尾巴
    .replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, '')
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '')   // onload/onclick 等
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
