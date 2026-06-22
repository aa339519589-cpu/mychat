export type ArtifactParsed = {
  display: string
  artifactHtml: string | null   // 完整 HTML（流式结束后才有）
  partialHtml: string | null    // 正在流式的部分内容（用于实时预览）
  artifactLoading: boolean
}

// 从消息文本中提取 <artifact>...</artifact> 块
export function parseArtifact(text: string): ArtifactParsed {
  const OPEN = '<artifact>'
  const CLOSE = '</artifact>'
  const openIdx = text.indexOf(OPEN)
  if (openIdx === -1) return { display: text, artifactHtml: null, partialHtml: null, artifactLoading: false }

  const beforeArtifact = text.slice(0, openIdx).trim()
  const innerStart = openIdx + OPEN.length
  const closeIdx = text.indexOf(CLOSE, innerStart)

  if (closeIdx === -1) {
    // 还在流式输出 artifact 内容——返回已有的部分
    return { display: beforeArtifact, artifactHtml: null, partialHtml: text.slice(innerStart), artifactLoading: true }
  }

  const artifactHtml = text.slice(innerStart, closeIdx).trim()
  const afterArtifact = text.slice(closeIdx + CLOSE.length).trim()
  const display = [beforeArtifact, afterArtifact].filter(Boolean).join('\n\n')
  return { display, artifactHtml, partialHtml: null, artifactLoading: false }
}

// 去掉脚本和结构标签，生成可安全内联渲染的预览 HTML
export function sanitizeForPreview(html: string): string {
  return html
    .replace(/<!DOCTYPE[^>]*>/gi, '')
    .replace(/<\/?html[^>]*>/gi, '')
    .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, '')
    .replace(/<\/?body[^>]*>/gi, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')  // 已完成的 script
    .replace(/<script\b[^>]*>[\s\S]*/gi, '')              // 尾部未完成的 script
    .replace(/<link[^>]*>/gi, '')
    .replace(/ on[a-z]+="[^"]*"/gi, '')
    .replace(/ on[a-z]+='[^']*'/gi, '')
}
