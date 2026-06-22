// 浏览器端 PDF 文字提取：pdfjs-dist + CMap，完整支持中文
// 仅在 client 组件调用，不可在 server 端使用
export async function extractPdfText(file: File): Promise<string> {
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

  return text.trim()
}
