import { createHash, timingSafeEqual } from 'node:crypto'

const OWNER_EMAIL_SHA256 = '39152592175115e5fd357fef985a882799da3c91132227639312c420208a4d68'

export function normalizeOwnerEmail(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? ''
}

export function isOwnerEmail(value: string | null | undefined): boolean {
  const normalized = normalizeOwnerEmail(value)
  if (!normalized) return false
  const actual = Buffer.from(createHash('sha256').update(normalized).digest('hex'), 'utf8')
  const expected = Buffer.from(OWNER_EMAIL_SHA256, 'utf8')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
