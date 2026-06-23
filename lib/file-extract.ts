// 把上传的文件转成可发送的附件：
// - PDF 有文字层：pdfjs 提字存入 text，后端注入消息
// - PDF 扫描件：前端把每页渲染成图片放进 pageImages，后端用小米 Omni OCR 成文字
// - 文本类文件：浏览器直接读取
export type AttachedFile = {
  name: string
  dataUrl: string   // 现统一为空字符串（扫描件改走 pageImages）
  isPdf: boolean
  text?: string
  pageImages?: string[]   // 扫描件每页的图片 data URL，交后端 OCR
}

const TEXT_EXTS = [
  ".txt", ".md", ".markdown", ".csv", ".json", ".log", ".xml", ".yaml", ".yml",
  ".html", ".htm", ".css", ".js", ".ts", ".tsx", ".jsx", ".py", ".java", ".c",
  ".cpp", ".h", ".go", ".rs", ".rb", ".php", ".sh", ".sql", ".ini", ".conf", ".toml",
]

function hasExt(name: string, exts: string[]) {
  const lower = name.toLowerCase()
  return exts.some(e => lower.endsWith(e))
}

export async function prepareFile(file: File): Promise<AttachedFile> {
  const name = file.name
  const isPdf = file.type === "application/pdf" || name.toLowerCase().endsWith(".pdf")
  if (isPdf) {
    try {
      const { extractPdf } = await import('./pdf-extract')
      const result = await extractPdf(file)
      if (result.kind === 'text') {
        return { name, dataUrl: "", isPdf: true, text: result.text }
      }
      // 扫描件：每页已渲染成图片，交后端用小米 Omni OCR
      return { name, dataUrl: "", isPdf: true, pageImages: result.images, text: "（扫描件，识别中…）" }
    } catch {
      return { name, dataUrl: "", isPdf: true, text: "（PDF 解析失败）" }
    }
  }
  if (file.type.startsWith("text/") || hasExt(name, TEXT_EXTS)) {
    const text = await file.text()
    return { name, dataUrl: "", isPdf: false, text }
  }
  const ext = name.includes(".") ? name.split(".").pop()!.toUpperCase() : "该"
  throw new Error(`暂不支持 ${ext} 文件，请上传 PDF 或文本文件`)
}
