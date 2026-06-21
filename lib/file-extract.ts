// 把上传的文件转成可发送的附件：
// - PDF 保留原始数据（base64），交给模型原生解析，质量最好
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
    const dataUrl = await readAsDataURL(file)
    return { name, dataUrl, isPdf: true }
  }
  if (file.type.startsWith("text/") || hasExt(name, TEXT_EXTS)) {
    const text = await file.text()
    return { name, dataUrl: "", isPdf: false, text }
  }
  const ext = name.includes(".") ? name.split(".").pop()!.toUpperCase() : "该"
  throw new Error(`暂不支持 ${ext} 文件，请上传 PDF 或文本文件`)
}
