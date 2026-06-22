// 把上传的文件转成可发送的附件：
// - PDF 有文字层：pdfjs 提字存入 text，后端注入消息
// - PDF 扫描件：dataUrl 保留原始 PDF base64，后端上传至 DeepSeek Files API 让模型原生识别
// - 文本类文件：浏览器直接读取
export type AttachedFile = {
  name: string
  dataUrl: string   // 扫描件 PDF：原始 base64；其余为空字符串
  isPdf: boolean
  text?: string
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

function readAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result as string)
    r.onerror = () => reject(new Error("读取文件失败"))
    r.readAsDataURL(file)
  })
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
      // 扫描件：保留原始 PDF，后端用 DeepSeek Files API 上传识别
      const dataUrl = await readAsDataURL(file)
      return { name, dataUrl, isPdf: true, text: "(扫描件，正在上传给 AI 识别)" }
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
