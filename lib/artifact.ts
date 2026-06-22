// 从消息文本里提取 <artifact>...</artifact> 块
// 返回原始内容（流式时是部分，完成时是完整），渲染端统一处理
export function parseArtifact(text: string): {
  display: string        // artifact 标签外的普通文字
  raw: string | null     // artifact 标签内的原始 HTML（部分或完整）；null 表示没有 artifact
  done: boolean          // 闭合标签是否已出现（决定是否执行脚本）
} {
  const OPEN = '<artifact>'
  const CLOSE = '</artifact>'
  const o = text.indexOf(OPEN)
  if (o === -1) return { display: text, raw: null, done: false }

  const before = text.slice(0, o).trim()
  const innerStart = o + OPEN.length
  const c = text.indexOf(CLOSE, innerStart)

  if (c === -1) {
    // 还在流式输出 artifact 内容
    return { display: before, raw: text.slice(innerStart), done: false }
  }

  const raw = text.slice(innerStart, c).trim()
  const after = text.slice(c + CLOSE.length).trim()
  return { display: [before, after].filter(Boolean).join('\n\n'), raw, done: true }
}

// 从 artifact HTML 里猜一个标题，给对话流里的卡片入口用
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
