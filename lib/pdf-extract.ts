// 浏览器端 PDF 处理：pdfjs-dist + CMap
// - 有文字层：提取文字（中文无乱码）
// - 扫描件（无文字层）：逐页渲染成图片，供视觉模型识别
// 仅在 client 组件调用，不可在 server 端使用

const MAX_SCAN_PAGES = 8  // 扫描件最多取前 N 页，避免 token 过多

export type PdfExtractResult =
  | { kind: 'text'; text: string }
  | { kind: 'scanned'; pages: string[]; totalPages: number }

export async function extractPdf(file: File): Promise<PdfExtractResult> {
  const pdfjsLib = await import('pdfjs-dist')
  pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs'

  const arrayBuffer = await file.arrayBuffer()
  const doc = await pdfjsLib.getDocument({
    data: new Uint8Array(arrayBuffer),
    cMapUrl: '/cmaps/',
    cMapPacked: true,
  }).promise

  // 先尝试提取文字层
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

  // 扫描件：逐页渲染成 JPEG 图片
  const totalPages = doc.numPages
  const pageCount = Math.min(totalPages, MAX_SCAN_PAGES)
  const pages: string[] = []
  for (let i = 1; i <= pageCount; i++) {
    const page = await doc.getPage(i)
    const viewport = page.getViewport({ scale: 1.5 })
    const canvas = document.createElement('canvas')
    canvas.width = viewport.width
    canvas.height = viewport.height
    const ctx = canvas.getContext('2d')!
    await page.render({ canvasContext: ctx, canvas, viewport }).promise
    pages.push(canvas.toDataURL('image/jpeg', 0.78))
    canvas.width = 0  // 释放内存
  }

  return { kind: 'scanned', pages, totalPages }
}

// 向后兼容旧调用
export async function extractPdfText(file: File): Promise<string> {
  const result = await extractPdf(file)
  return result.kind === 'text' ? result.text : ''
}
