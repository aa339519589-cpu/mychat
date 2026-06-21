import { NextRequest } from "next/server"
import { extractText, getDocumentProxy } from "unpdf"

export const runtime = "nodejs"

// 接收上传的 PDF，提取其中的文字并返回
export async function POST(req: NextRequest) {
  try {
    const form = await req.formData()
    const file = form.get("file")
    if (!(file instanceof File)) {
      return Response.json({ error: "缺少文件" }, { status: 400 })
    }

    const buf = new Uint8Array(await file.arrayBuffer())
    const pdf = await getDocumentProxy(buf)
    const { text } = await extractText(pdf, { mergePages: true })
    const out = Array.isArray(text) ? text.join("\n\n") : text

    if (!out || !out.trim()) {
      return Response.json(
        { error: "这个 PDF 没有可提取的文字（可能是扫描成图片的）" },
        { status: 422 },
      )
    }
    return Response.json({ text: out })
  } catch (e) {
    console.error("extract", e)
    return Response.json({ error: "PDF 解析失败，请确认文件未损坏" }, { status: 500 })
  }
}
