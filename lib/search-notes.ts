import { isSafeExternalHttpsUrl, isSafeExternalHttpUrl } from './external-url'
import { isRecord } from './unknown-value'

export type SearchResult = {
  title: string
  url: string
  snippet?: string
  published_at?: string
  favicon_url?: string
  thumbnail_url?: string
}

export type SearchImage = { url: string; description?: string }

export type SearchNote = {
  kind: 'web' | 'image'
  query: string
  results: SearchResult[]
  images: SearchImage[]
}

const MAX_SEARCH_NOTES = 32
const MAX_SEARCH_RESULTS = 50
const MAX_QUERY_CHARS = 1_000
const MAX_TITLE_CHARS = 1_000
const MAX_SNIPPET_CHARS = 2_000
const MAX_IMAGE_DESCRIPTION_CHARS = 240

function optionalText(value: unknown, maximum: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim().slice(0, maximum)
  return text || undefined
}

function normalizeSearchNote(value: unknown): SearchNote | null {
  if (!isRecord(value) || typeof value.query !== 'string' || !Array.isArray(value.results)) return null
  const results = value.results.flatMap(result => {
    if (!isRecord(result)
      || typeof result.title !== 'string'
      || !isSafeExternalHttpUrl(result.url)) return []
    const snippet = optionalText(result.snippet, MAX_SNIPPET_CHARS)
    const publishedAt = optionalText(result.published_at, 120)
    return [{
      title: result.title.slice(0, MAX_TITLE_CHARS),
      url: result.url,
      ...(snippet ? { snippet } : {}),
      ...(publishedAt ? { published_at: publishedAt } : {}),
      ...(isSafeExternalHttpsUrl(result.favicon_url) ? { favicon_url: result.favicon_url } : {}),
      ...(isSafeExternalHttpsUrl(result.thumbnail_url) ? { thumbnail_url: result.thumbnail_url } : {}),
    }]
  }).slice(0, MAX_SEARCH_RESULTS)
  const images = Array.isArray(value.images)
    ? value.images.flatMap(image => {
      if (!isRecord(image) || !isSafeExternalHttpsUrl(image.url)) return []
      const description = optionalText(image.description, MAX_IMAGE_DESCRIPTION_CHARS)
      return [{ url: image.url, ...(description ? { description } : {}) }]
    }).slice(0, 12)
    : []
  return {
    kind: value.kind === 'image' ? 'image' : 'web',
    query: value.query.slice(0, MAX_QUERY_CHARS),
    results,
    images,
  }
}

export function normalizeSearchNotes(value: unknown): SearchNote[] {
  if (!Array.isArray(value)) return []
  return value
    .slice(0, MAX_SEARCH_NOTES)
    .map(normalizeSearchNote)
    .filter((note): note is SearchNote => note !== null)
}
