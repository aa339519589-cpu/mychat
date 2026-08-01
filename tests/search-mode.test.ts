import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSearchQueries, latestBeijingDateFromMessages, normalizeSearchMode, searchSourceBudget } from '../lib/search-mode'

test('latestBeijingDateFromMessages uses the newest message timestamp', () => {
  assert.equal(
    latestBeijingDateFromMessages([
      { ts: '2026-06-24T10:00:00.000Z' },
      { ts: '2026-06-25T01:00:00.000Z' },
      { ts: 'invalid' },
    ]),
    '2026-06-25',
  )
})

test('normalizeSearchMode supports current and legacy inputs', () => {
  assert.equal(normalizeSearchMode('web'), 'web')
  assert.equal(normalizeSearchMode('deep'), 'deep')
  assert.equal(normalizeSearchMode(true), 'web')
  assert.equal(normalizeSearchMode(false, true), 'deep')
  assert.equal(normalizeSearchMode(false, false), 'off')
})

test('search budgets match product rules', () => {
  assert.deepEqual(searchSourceBudget('web'), { min: 1, max: 20, target: 12 })
  assert.deepEqual(searchSourceBudget('deep'), { min: 40, max: 80, target: 48 })
})

test('deep search expands into multiple date-anchored queries', () => {
  const web = buildSearchQueries('OpenAI 最新模型', 'web', '2026-06-25')
  const deep = buildSearchQueries('OpenAI 最新模型', 'deep', '2026-06-25')
  assert.equal(web.length, 1)
  assert.ok(web[0].includes('2026-06-25'))
  assert.ok(deep.length >= 6)
  assert.ok(deep.every(query => query.includes('2026-06-25')))
})
