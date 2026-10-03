import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isMemoryId,
  normalizeMemoryTopic,
  parseMemoryImportInput,
  parseMemoryInput,
} from '../lib/api/memory-input'

test('memory input trims content and normalizes stable topic names', () => {
  assert.deepEqual(parseMemoryInput({
    content: '  Keep Chinese output in concise paragraphs.  ',
    topic: '  Work   preferences  ',
  }), {
    content: 'Keep Chinese output in concise paragraphs.',
    topic: 'Work preferences',
  })
  assert.equal(normalizeMemoryTopic(undefined), 'General')
  assert.equal(normalizeMemoryTopic(''), 'General')
  assert.equal(normalizeMemoryTopic('  '), null)
})

test('memory input rejects malformed or oversized content and topics', () => {
  assert.equal(parseMemoryInput(null), null)
  assert.equal(parseMemoryInput({ content: 12 }), null)
  assert.equal(parseMemoryInput({ content: '   ' }), null)
  assert.equal(parseMemoryInput({ content: 'x'.repeat(20_001) }), null)
  assert.equal(parseMemoryInput({ content: 'valid', topic: 'x'.repeat(81) }), null)
  assert.equal(parseMemoryInput({ content: 'valid', topic: 'bad\u0000topic' }), null)
})

test('memory ids must be canonical UUID strings', () => {
  assert.equal(isMemoryId('00000000-0000-4000-8000-000000000001'), true)
  assert.equal(isMemoryId('00000000000040008000000000000001'), false)
  assert.equal(isMemoryId('../memory'), false)
})

test('memory import validates a bounded batch and removes exact duplicates', () => {
  assert.deepEqual(parseMemoryImportInput({ memories: [
    { content: '  Prefers concise answers. ', topic: 'Style' },
    { content: 'Prefers concise answers.', topic: 'style' },
    { content: 'Uses Swift for iOS work.', topic: 'Projects' },
  ] }), [
    { content: 'Prefers concise answers.', topic: 'Style' },
    { content: 'Uses Swift for iOS work.', topic: 'Projects' },
  ])
  assert.equal(parseMemoryImportInput({ memories: [] }), null)
  assert.equal(parseMemoryImportInput({ memories: [{ content: 'ok' }, { content: ' ' }] }), null)
  assert.equal(parseMemoryImportInput({ memories: Array.from({ length: 101 }, () => ({ content: 'x' })) }), null)
})
