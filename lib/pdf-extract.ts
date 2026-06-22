// 浏览器端 PDF 处理：pdfjs-dist + CMap，完整支持中文
// - 有文字层：提取文字
// - 扫描件（无文字层）：返回 scanned，由后端通过 DeepSeek Files API 上传原始 PDF 让模型识别
// 仅在 client 组件调用，不可在 server 端使用

export type PdfExtractResult =
  | { kind: 'text'; text: string }
  | { kind: 'scanned' }

export async function extractPdf(file: File): Promise<PdfExtractResult> {
  const pdfjsLib = await import('pdfjs-dist')
  pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs'

  const arrayBuffer = await file.arrayBuffer()
  const doc = await pdfjsLib.getDocument({
    data: new Uint8Array(arrayBuffer),
    cMapUrl: '/cmaps/',
    cMapPacked: true,
  }).promise

  let text = ''
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const content = await page.getTextContent()
    let lastY = 0, line = ''
    for (const item of content.items) {
      const it = item as any
      const y: number = it.transform?.[5] ?? 0
      if (lastY && Math.abs(y - lastY) > 2) { text += line + '\n'; line = '' }
      line += it.str ?? ''
      lastY = y
    }
    if (line) text += line + '\n'
  }

  if (text.trim()) return { kind: 'text', text: text.trim() }
  return { kind: 'scanned' }
}
