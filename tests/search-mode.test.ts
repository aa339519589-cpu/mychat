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
  assert.equal(normalizeSearchMode(true), 'web')
  assert.equal(normalizeSearchMode(false), 'off')
  assert.equal(normalizeSearchMode(undefined), 'off')
})

test('search budgets match product rules', () => {
  assert.deepEqual(searchSourceBudget('web'), { min: 1, max: 20, target: 12 })
  assert.deepEqual(searchSourceBudget('off'), { min: 0, max: 0, target: 0 })
})

test('web search builds a single date-anchored query', () => {
  const web = buildSearchQueries('OpenAI 最新模型', '2026-06-25')
  assert.equal(web.length, 1)
  assert.ok(web[0].includes('2026-06-25'))
})
