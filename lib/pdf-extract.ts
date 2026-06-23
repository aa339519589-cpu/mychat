// 浏览器端 PDF 处理：pdfjs-dist + CMap，完整支持中文
// - 有文字层：提取文字
// - 扫描件（无文字层）：把每页渲染成图片，交后端用小米 MiMo-Omni 视觉模型 OCR 成文字
// 仅在 client 组件调用，不可在 server 端使用

export type PdfExtractResult =
  | { kind: 'text'; text: string }
  | { kind: 'scanned'; images: string[] }

const MAX_RENDER_PAGES = 18   // 扫描件最多渲染多少页

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

  // 扫描件：无文字层 → 把每页渲染成 JPEG，交后端 OCR
  const images: string[] = []
  const n = Math.min(doc.numPages, MAX_RENDER_PAGES)
  for (let i = 1; i <= n; i++) {
    const page = await doc.getPage(i)
    const viewport = page.getViewport({ scale: 2 })
    const canvas = document.createElement('canvas')
    canvas.width = viewport.width
    canvas.height = viewport.height
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    await page.render({ canvasContext: ctx, viewport } as any).promise
    images.push(canvas.toDataURL('image/jpeg', 0.85))
  }
  return { kind: 'scanned', images }
}
