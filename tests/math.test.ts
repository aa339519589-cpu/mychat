import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeMathDelimiters } from '../lib/math'

test('normalizes bracket math delimiters for markdown math renderer', () => {
  assert.equal(
    normalizeMathDelimiters('公式：\\( a^2+b^2=c^2 \\)'),
    '公式：$a^2+b^2=c^2$',
  )
  assert.equal(
    normalizeMathDelimiters('结果：\\[ \\frac{a}{b} \\]'),
    '结果：$$\n\\frac{a}{b}\n$$',
  )
})

test('does not normalize math delimiters inside code spans or fences', () => {
  const input = '`\\(x\\)`\n\n```txt\n\\[x\\]\n```\n\n正文 \\(y\\)'
  assert.equal(
    normalizeMathDelimiters(input),
    '`\\(x\\)`\n\n```txt\n\\[x\\]\n```\n\n正文 $y$',
  )
})
