export type ArtifactParsed = {
  display: string
  // 面板 artifact（需要自己的视觉环境，如红色立方体、复杂报告）
  raw: string | null
  done: boolean
  // 内联 artifact（颜色与背景无关，直接流式渲染在对话里）
  inlineRaw: string | null
  inlineDone: boolean
}

export function parseArtifact(text: string): ArtifactParsed {
  // 先尝试 inline-artifact
  const IO = text.indexOf('<inline-artifact>')
  if (IO !== -1) {
    const before = text.slice(0, IO).trim()
    const bodyStart = IO + '<inline-artifact>'.length
    const IC = text.indexOf('</inline-artifact>', bodyStart)
    if (IC === -1) {
      return { display: before, raw: null, done: false, inlineRaw: text.slice(bodyStart), inlineDone: false }
    }
    const inlineRaw = text.slice(bodyStart, IC).trim()
    const after = text.slice(IC + '</inline-artifact>'.length).trim()
    return { display: [before, after].filter(Boolean).join('\n\n'), raw: null, done: false, inlineRaw, inlineDone: true }
  }

  // 再尝试 panel artifact
  const O = text.indexOf('<artifact>')
  if (O === -1) return { display: text, raw: null, done: false, inlineRaw: null, inlineDone: false }
  const before = text.slice(0, O).trim()
  const bodyStart = O + '<artifact>'.length
  const C = text.indexOf('</artifact>', bodyStart)
  if (C === -1) {
    return { display: before, raw: text.slice(bodyStart), done: false, inlineRaw: null, inlineDone: false }
  }
  const raw = text.slice(bodyStart, C).trim()
  const after = text.slice(C + '</artifact>'.length).trim()
  return { display: [before, after].filter(Boolean).join('\n\n'), raw, done: true, inlineRaw: null, inlineDone: false }
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
