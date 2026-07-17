import { isSafeExternalHttpUrl } from './external-url'
import { isRecord } from './unknown-value'

export type SearchNote = {
  query: string
  results: Array<{ title: string; url: string }>
}

const MAX_SEARCH_NOTES = 32
const MAX_SEARCH_RESULTS = 50
const MAX_QUERY_CHARS = 1_000
const MAX_TITLE_CHARS = 1_000

function normalizeSearchNote(value: unknown): SearchNote | null {
  if (!isRecord(value) || typeof value.query !== 'string' || !Array.isArray(value.results)) return null
  const results = value.results.flatMap(result => {
    if (!isRecord(result)
      || typeof result.title !== 'string'
      || !isSafeExternalHttpUrl(result.url)) return []
    return [{ title: result.title.slice(0, MAX_TITLE_CHARS), url: result.url }]
  }).slice(0, MAX_SEARCH_RESULTS)
  return { query: value.query.slice(0, MAX_QUERY_CHARS), results }
}

export function normalizeSearchNotes(value: unknown): SearchNote[] {
  if (!Array.isArray(value)) return []
  return value
    .slice(0, MAX_SEARCH_NOTES)
    .map(normalizeSearchNote)
    .filter((note): note is SearchNote => note !== null)
}
