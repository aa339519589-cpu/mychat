// 把上传的文件提取成纯文本：PDF 走后端解析，文本类文件直接在浏览器读取
export type ExtractedFile = { name: string; text: string }

const TEXT_EXTS = [
  ".txt", ".md", ".markdown", ".csv", ".json", ".log", ".xml", ".yaml", ".yml",
  ".html", ".htm", ".css", ".js", ".ts", ".tsx", ".jsx", ".py", ".java", ".c",
  ".cpp", ".h", ".go", ".rs", ".rb", ".php", ".sh", ".sql", ".ini", ".conf", ".toml",
]

function hasExt(name: string, exts: string[]) {
  const lower = name.toLowerCase()
  return exts.some(e => lower.endsWith(e))
}

export async function extractFileText(file: File): Promise<ExtractedFile> {
  const name = file.name
  const isPdf = file.type === "application/pdf" || name.toLowerCase().endsWith(".pdf")

  if (isPdf) {
    const form = new FormData()
    form.append("file", file)
    const res = await fetch("/api/extract", { method: "POST", body: form })
    const data = await res.json().catch(() => null)
    if (!res.ok) throw new Error(data?.error ?? "PDF 解析失败")
    return { name, text: String(data?.text ?? "") }
  }

  // 文本类文件直接读
  if (file.type.startsWith("text/") || hasExt(name, TEXT_EXTS)) {
    const text = await file.text()
    return { name, text }
  }

  const ext = name.includes(".") ? name.split(".").pop()!.toUpperCase() : "该"
  throw new Error(`暂不支持解析 ${ext} 文件，请上传 PDF 或文本文件`)
}
