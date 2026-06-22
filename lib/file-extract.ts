// 把上传的文件转成可发送的附件：
// - PDF 用 pdfjs-dist 在浏览器提取文字（支持中文），结果存入 text 字段，后端直接使用
// - 文本类文件直接在浏览器读取内容
export type AttachedFile = { name: string; dataUrl: string; isPdf: boolean; text?: string }

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
      const { extractPdfText } = await import('./pdf-extract')
      const text = await extractPdfText(file)
      return { name, dataUrl: "", isPdf: true, text: text || "（未能提取文字，可能是扫描件）" }
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
