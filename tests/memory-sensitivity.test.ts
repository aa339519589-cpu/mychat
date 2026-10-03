import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyMemorySensitivity } from '@/lib/api/memory-sensitivity'

test('ordinary preferences are not classified as sensitive', () => {
  assert.deepEqual(classifyMemorySensitivity('The user prefers concise answers.'), {
    sensitive: false,
    prohibited: false,
  })
})

test('health, belief, and financial topics require opt-in', () => {
  for (const content of [
    'The user has diabetes and takes medication.',
    '用户的宗教信仰是佛教。',
    'The user has significant debt.',
  ]) {
    assert.deepEqual(classifyMemorySensitivity(content), { sensitive: true, prohibited: false })
  }
})

test('government identifiers, criminal history, account numbers, and immigration status are never saved', () => {
  for (const content of [
    'The user shared their passport number.',
    '用户的身份证号码是 123456。',
    'The user described their criminal record.',
    'The user supplied a bank account number.',
    'The user described their visa status.',
  ]) {
    assert.deepEqual(classifyMemorySensitivity(content), { sensitive: true, prohibited: true })
  }
})
