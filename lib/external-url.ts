const MAX_EXTERNAL_URL_CHARS = 8_192

export function isSafeExternalHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string'
    || !value
    || value.length > MAX_EXTERNAL_URL_CHARS
    || value !== value.trim()) return false
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && !url.username
      && !url.password
  } catch {
    return false
  }
}

export function isSafeExternalHttpsUrl(value: unknown): value is string {
  return isSafeExternalHttpUrl(value) && new URL(value).protocol === 'https:'
}
