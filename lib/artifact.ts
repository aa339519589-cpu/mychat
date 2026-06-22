// 从消息文本中提取 <artifact>...</artifact> 块
export function parseArtifact(text: string): {
  display: string       // artifact 标签外的文字，显示给用户
  artifactHtml: string | null   // artifact 内部的 HTML，null 表示尚未完成
  artifactLoading: boolean      // 检测到开始标签但还没有结束标签（仍在流式生成）
} {
  const OPEN = '<artifact>'
  const CLOSE = '</artifact>'
  const openIdx = text.indexOf(OPEN)
  if (openIdx === -1) return { display: text, artifactHtml: null, artifactLoading: false }

  const beforeArtifact = text.slice(0, openIdx).trim()
  const innerStart = openIdx + OPEN.length
  const closeIdx = text.indexOf(CLOSE, innerStart)

  if (closeIdx === -1) {
    // 还在流式输出 artifact 内容
    return { display: beforeArtifact, artifactHtml: null, artifactLoading: true }
  }

  const artifactHtml = text.slice(innerStart, closeIdx).trim()
  const afterArtifact = text.slice(closeIdx + CLOSE.length).trim()
  const display = [beforeArtifact, afterArtifact].filter(Boolean).join('\n\n')
  return { display, artifactHtml, artifactLoading: false }
}
