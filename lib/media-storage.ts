import { createClient } from "@/lib/supabase/client"
import type { GeneratedMedia } from "@/lib/generated-media"
import { isSafeGeneratedMediaUrl, normalizeGeneratedMedia } from "@/lib/generated-media"

const BUCKET = "generated-media"
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024

function extForMime(mime?: string): string {
  const m = (mime ?? "").toLowerCase()
  if (m.includes("png")) return "png"
  if (m.includes("webp")) return "webp"
  if (m.includes("gif")) return "gif"
  if (m.includes("webm")) return "webm"
  if (m.includes("mp4")) return "mp4"
  return "jpg"
}

function parseDataUrl(url: string): { mime: string; bytes: Uint8Array } | null {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(url.trim())
  if (!match) return null
  const mime = match[1].toLowerCase()
  const b64 = match[2].replace(/\s/g, "")
  try {
    const bin = atob(b64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return { mime, bytes }
  } catch {
    return null
  }
}

async function fetchRemoteBytes(url: string): Promise<{ mime: string; bytes: Uint8Array } | null> {
  try {
    const res = await fetch(url, { mode: "cors" })
    if (!res.ok) return null
    const mime = (res.headers.get("content-type") ?? "image/jpeg").split(";")[0].trim().toLowerCase()
    const buf = new Uint8Array(await res.arrayBuffer())
    if (!buf.byteLength || buf.byteLength > MAX_UPLOAD_BYTES) return null
    return { mime, bytes: buf }
  } catch {
    return null
  }
}

/**
 * Persist a generated media item to Supabase Storage when possible.
 * Falls back to a safe public HTTPS URL, then to the original data URL.
 */
export async function persistGeneratedMedia(
  userId: string,
  conversationId: string,
  media: GeneratedMedia,
): Promise<GeneratedMedia> {
  const normalized = normalizeGeneratedMedia(media)
  if (!normalized) return media

  console.info("[image-generation] provider result", {
    conversationId,
    type: normalized.type,
    urlKind: /^data:/i.test(normalized.url) ? "data" : /^https?:/i.test(normalized.url) ? "https" : "other",
    mimeType: normalized.mimeType,
    urlLen: normalized.url.length,
  })

  const fromData = /^data:/i.test(normalized.url) ? parseDataUrl(normalized.url) : null
  const fromRemote = !fromData && /^https?:\/\//i.test(normalized.url)
    ? await fetchRemoteBytes(normalized.url)
    : null
  const payload = fromData ?? fromRemote

  if (payload && payload.bytes.byteLength > 0 && payload.bytes.byteLength <= MAX_UPLOAD_BYTES) {
    try {
      const supabase = createClient()
      const assetId = crypto.randomUUID()
      const ext = extForMime(payload.mime || normalized.mimeType)
      const objectKey = `${userId}/${conversationId}/${assetId}.${ext}`
      const { error } = await supabase.storage.from(BUCKET).upload(objectKey, payload.bytes, {
        contentType: payload.mime || normalized.mimeType || (normalized.type === "image" ? "image/jpeg" : "video/mp4"),
        upsert: false,
      })
      if (!error) {
        const { data } = supabase.storage.from(BUCKET).getPublicUrl(objectKey)
        const publicUrl = data?.publicUrl
        if (publicUrl && isSafeGeneratedMediaUrl(normalized.type, publicUrl)) {
          console.info("[image-generation] asset stored", { assetId, objectKey, publicUrl: publicUrl.slice(0, 120) })
          return {
            type: normalized.type,
            url: publicUrl,
            mimeType: payload.mime || normalized.mimeType,
            alt: normalized.alt,
          }
        }
      } else {
        console.warn("[image-generation] storage upload failed", error.message)
      }
    } catch (e) {
      console.warn("[image-generation] storage upload exception", e)
    }
  }

  // Prefer original public HTTPS over huge data URLs for history durability.
  if (/^https?:\/\//i.test(normalized.url) && isSafeGeneratedMediaUrl(normalized.type, normalized.url)) {
    return normalized
  }
  return normalized
}

export async function persistGeneratedMediaList(
  userId: string,
  conversationId: string,
  media: GeneratedMedia[],
): Promise<GeneratedMedia[]> {
  const out: GeneratedMedia[] = []
  for (const item of media) {
    out.push(await persistGeneratedMedia(userId, conversationId, item))
  }
  return out
}
