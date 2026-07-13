import assert from 'node:assert/strict'
import test from 'node:test'

import { clientAddress, requestId } from '../lib/api/request'

test('requestId preserves the trusted proxy id and rejects malformed values', () => {
  const forwarded = new Request('https://example.test', {
    headers: { 'x-request-id': '550e8400-e29b-41d4-a716-446655440000' },
  })
  assert.equal(requestId(forwarded), '550e8400-e29b-41d4-a716-446655440000')

  const malformed = new Request('https://example.test', {
    headers: { 'x-request-id': 'bad' },
  })
  const first = requestId(malformed)
  assert.match(first, /^[0-9a-f-]{36}$/)
  assert.equal(requestId(malformed), first)
})

test('clientAddress trusts only the platform forwarded chain and validates IPs', () => {
  const forwarded = new Request('https://example.test', {
    headers: {
      'x-forwarded-for': '198.51.100.24, 10.0.0.4',
      'cf-connecting-ip': '203.0.113.99',
      'x-real-ip': '203.0.113.98',
    },
  })
  assert.equal(clientAddress(forwarded), '198.51.100.24')

  const spoofedAlternatives = new Request('https://example.test', {
    headers: {
      'x-forwarded-for': 'not-an-ip',
      'cf-connecting-ip': '203.0.113.99',
      'x-real-ip': '203.0.113.98',
    },
  })
  assert.equal(clientAddress(spoofedAlternatives), 'unknown')
})
