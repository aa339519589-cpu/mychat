// 把上传的文件转成可发送的附件：
// - PDF 有文字层：pdfjs-dist 提字存入 text，后端直接注入
// - PDF 扫描件：逐页渲染成图片存入 pages，发送时附到消息 images 供视觉模型识别
// - 文本类文件：浏览器直接读取内容
export type AttachedFile = {
  name: string
  dataUrl: string
  isPdf: boolean
  text?: string
  pages?: string[]  // 扫描件各页 JPEG base64；发送时临时用，不落库
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
      // 扫描件：把页数信息写进 text，页面图片存入 pages
      const truncated = result.totalPages > result.pages.length
      const hint = truncated
        ? `（扫描件，已转换前 ${result.pages.length} 页为图片，共 ${result.totalPages} 页）`
        : `（扫描件，已转换全部 ${result.totalPages} 页为图片）`
      return { name, dataUrl: "", isPdf: true, text: hint, pages: result.pages }
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
