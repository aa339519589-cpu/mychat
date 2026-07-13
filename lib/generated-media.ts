export type GeneratedMedia = {
  type: "image" | "video"
  url: string
  mimeType?: string
  alt?: string
}

export const MAX_GENERATED_MEDIA_ITEMS = 4

const MAX_MEDIA_URL_CHARS = 16 * 1024 * 1024
const MAX_REMOTE_MEDIA_URL_CHARS = 8 * 1024
const IMAGE_DATA_URL = /^data:image\/(?:png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=_-]+$/i
const VIDEO_DATA_URL = /^data:video\/(?:mp4|webm|quicktime);base64,[A-Za-z0-9+/=_-]+$/i
const UUID_SEGMENT = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const ASSET_SEGMENT = '[A-Za-z0-9][A-Za-z0-9_-]{0,127}\\.(?:png|jpg|webp|gif|mp4|webm|mov)'
const OBJECT_KEY = new RegExp(`^${UUID_SEGMENT}/${UUID_SEGMENT}/${UUID_SEGMENT}/${ASSET_SEGMENT}$`, 'i')
const CONTROLLED_PREFIX = '/api/v1/media/'
const PUBLIC_STORAGE_PREFIX = '/storage/v1/object/public/generated-media/'
const AUTHENTICATED_STORAGE_PREFIX = '/storage/v1/object/authenticated/generated-media/'

export function controlledGeneratedMediaUrl(objectKey: string, origin?: string): string {
  if (!OBJECT_KEY.test(objectKey)) throw new TypeError('Invalid generated media object key')
  const path = `${CONTROLLED_PREFIX}${objectKey}/content`
  if (!origin) return path
  const parsed = new URL(origin)
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new TypeError('Invalid generated media proxy origin')
  }
  return new URL(path, parsed.origin).toString()
}

/** Parse only canonical BFF references or the exact legacy Storage URL shape. */
export function generatedMediaObjectKey(value: unknown): string | null {
  if (typeof value !== 'string' || !value || value.length > MAX_REMOTE_MEDIA_URL_CHARS) return null
  let pathname: string
  if (value.startsWith('/')) {
    if (value.includes('?') || value.includes('#')) return null
    pathname = value
  } else {
    if (!/^https?:\/\//i.test(value)) return null
    try {
      const parsed = new URL(value)
      if (parsed.username || parsed.password || parsed.search || parsed.hash) return null
      pathname = parsed.pathname
    } catch {
      return null
    }
  }
  let key: string | null = null
  if (pathname.startsWith(CONTROLLED_PREFIX) && pathname.endsWith('/content')) {
    key = pathname.slice(CONTROLLED_PREFIX.length, -'/content'.length)
  } else if (pathname.startsWith(PUBLIC_STORAGE_PREFIX)) {
    key = pathname.slice(PUBLIC_STORAGE_PREFIX.length)
  } else if (pathname.startsWith(AUTHENTICATED_STORAGE_PREFIX)) {
    key = pathname.slice(AUTHENTICATED_STORAGE_PREFIX.length)
  }
  return key && OBJECT_KEY.test(key) ? key : null
}

function isSupportedGeneratedMediaUrl(type: GeneratedMedia["type"], value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > MAX_MEDIA_URL_CHARS) return false
  if (generatedMediaObjectKey(value)) return true
  if (/^https?:\/\//i.test(value)) {
    if (value.length > MAX_REMOTE_MEDIA_URL_CHARS) return false
    try {
      const parsed = new URL(value)
      return (parsed.protocol === "http:" || parsed.protocol === "https:")
        && !parsed.username
        && !parsed.password
    } catch {
      return false
    }
  }
  return type === "image" ? IMAGE_DATA_URL.test(value) : VIDEO_DATA_URL.test(value)
}

function isPrivateIpv4(hostname: string): boolean {
  const octets = hostname.split(".").map(Number)
  if (octets.length !== 4 || octets.some(value => !Number.isInteger(value) || value < 0 || value > 255)) return false
  const [a, b] = octets
  if (hostname === "168.63.129.16") return true
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || a >= 224
}

function parseIpv6(hostname: string): number[] | null {
  if (!hostname.includes(":")) return null
  const halves = hostname.toLowerCase().split("::")
  if (halves.length > 2) return null
  const parseHalf = (value: string): number[] | null => {
    if (!value) return []
    const result: number[] = []
    for (const token of value.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(token)) return null
      result.push(Number.parseInt(token, 16))
    }
    return result
  }
  const left = parseHalf(halves[0])
  const right = parseHalf(halves[1] ?? "")
  if (!left || !right) return null
  if (halves.length === 1) return left.length === 8 ? left : null
  const missing = 8 - left.length - right.length
  if (missing < 1) return null
  return [...left, ...Array<number>(missing).fill(0), ...right]
}

function embeddedIpv4(high: number, low: number): string {
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`
}

function isPrivateIpv6(hostname: string): boolean {
  const words = parseIpv6(hostname)
  if (!words) return true
  const allZeroBeforeLast = words.slice(0, 7).every(word => word === 0)
  if ((allZeroBeforeLast && (words[7] === 0 || words[7] === 1))
    || (words[0] & 0xfe00) === 0xfc00
    || (words[0] & 0xffc0) === 0xfe80
    || (words[0] & 0xff00) === 0xff00
    || (words[0] === 0x100 && words.slice(1, 4).every(word => word === 0))
    || (words[0] === 0x2001 && words[1] === 0x2 && words[2] === 0)
    || (words[0] === 0x2001 && words[1] === 0xdb8)) return true

  const embeddedIsPrivate = (high: number, low: number) => isPrivateIpv4(embeddedIpv4(high, low))
  const firstFiveZero = words.slice(0, 5).every(word => word === 0)
  const firstSixZero = words.slice(0, 6).every(word => word === 0)

  // IPv4-mapped, translated, and deprecated IPv4-compatible forms.
  if ((firstFiveZero && words[5] === 0xffff && embeddedIsPrivate(words[6], words[7]))
    || (words.slice(0, 4).every(word => word === 0)
      && words[4] === 0xffff && words[5] === 0
      && embeddedIsPrivate(words[6], words[7]))
    || (firstSixZero && embeddedIsPrivate(words[6], words[7]))) return true
  // Well-known NAT64 prefix 64:ff9b::/96.
  if (words[0] === 0x64 && words[1] === 0xff9b
    && words.slice(2, 6).every(word => word === 0)
    && embeddedIsPrivate(words[6], words[7])) return true
  // Local-use NAT64 addresses are internal by definition; block the full /48.
  if (words[0] === 0x64 && words[1] === 0xff9b && words[2] === 1) return true
  // 6to4 embeds IPv4 immediately after 2002::/16.
  if (words[0] === 0x2002 && embeddedIsPrivate(words[1], words[2])) return true
  // Teredo addresses obscure an IPv4 address; fail closed instead of trying
  // to reproduce every server/client encoding variant in the browser.
  if (words[0] === 0x2001 && words[1] === 0) return true
  // ISATAP interface identifiers use 0:5efe followed by an IPv4 address.
  if (words[4] === 0 && words[5] === 0x5efe && embeddedIsPrivate(words[6], words[7])) return true
  return false
}

export function isPrivateNetworkGeneratedMediaUrl(value: unknown): boolean {
  if (typeof value !== "string" || !/^https?:\/\//i.test(value)) return false
  let hostname: string
  try {
    hostname = new URL(value).hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "")
  } catch {
    return false
  }
  if (!hostname
    || hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname.endsWith(".local")
    || hostname.endsWith(".localdomain")
    || hostname.endsWith(".internal")
    || hostname.endsWith(".lan")
    || hostname.endsWith(".home.arpa")
    || (!hostname.includes(".") && !hostname.includes(":"))) return true
  if (isPrivateIpv4(hostname)) return true
  return hostname.includes(":") && isPrivateIpv6(hostname)
}

export function isSafeGeneratedMediaUrl(type: GeneratedMedia["type"], value: unknown): value is string {
  if (generatedMediaObjectKey(value)) return true
  return isSupportedGeneratedMediaUrl(type, value) && !isPrivateNetworkGeneratedMediaUrl(value)
}

export function hasInlineGeneratedMedia(media: readonly GeneratedMedia[] | undefined): boolean {
  return !!media?.some(item => typeof item?.url === "string" && /^data:/i.test(item.url))
}

export function normalizeGeneratedMedia(value: unknown): GeneratedMedia | null {
  if (!value || typeof value !== "object") return null
  const source = value as Record<string, unknown>
  if (source.type !== "image" && source.type !== "video") return null
  // Preserve blocked URLs so the renderer can show an explicit safety error.
  if (!isSupportedGeneratedMediaUrl(source.type, source.url)) return null
  const objectKey = generatedMediaObjectKey(source.url)
  return {
    type: source.type,
    url: objectKey ? controlledGeneratedMediaUrl(objectKey) : source.url,
    ...(typeof source.mimeType === "string" ? { mimeType: source.mimeType.slice(0, 100) } : {}),
    ...(typeof source.alt === "string" ? { alt: source.alt.slice(0, 500) } : {}),
  }
}

export function normalizeGeneratedMediaList(value: unknown): GeneratedMedia[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const media: GeneratedMedia[] = []
  for (const item of value) {
    const normalized = normalizeGeneratedMedia(item)
    if (!normalized || seen.has(`${normalized.type}:${normalized.url}`)) continue
    seen.add(`${normalized.type}:${normalized.url}`)
    media.push(normalized)
    if (media.length >= MAX_GENERATED_MEDIA_ITEMS) break
  }
  return media
}
