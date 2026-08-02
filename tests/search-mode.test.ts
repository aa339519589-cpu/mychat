import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildSearchQueries,
  inferSearchTimeRange,
  latestBeijingDateFromMessages,
  normalizeSearchMode,
  searchSourceBudget,
} from '../lib/search-mode'

test('latestBeijingDateFromMessages uses the newest message timestamp', () => {
  assert.equal(
    latestBeijingDateFromMessages([
      { ts: '2026-06-24T10:00:00.000Z' },
      { ts: '2026-06-25T01:00:00.000Z' },
      { ts: 'invalid' },
    ], new Date('2026-06-24T00:00:00.000Z')),
    '2026-06-25',
  )
})

test('latestBeijingDateFromMessages never anchors search behind current time', () => {
  assert.equal(
    latestBeijingDateFromMessages(
      [{ ts: '2026-06-25T01:00:00.000Z' }],
      new Date('2026-08-02T08:00:00.000Z'),
    ),
    '2026-08-02',
  )
})

test('normalizeSearchMode supports current and legacy inputs', () => {
  assert.equal(normalizeSearchMode('web'), 'web')
  assert.equal(normalizeSearchMode(true), 'web')
  assert.equal(normalizeSearchMode('deep'), 'off')
  assert.equal(normalizeSearchMode(false), 'off')
  assert.equal(normalizeSearchMode(undefined), 'off')
})

test('search budgets match product rules', () => {
  assert.deepEqual(searchSourceBudget('web'), { min: 1, max: 20, target: 12 })
  assert.deepEqual(searchSourceBudget('off'), { min: 0, max: 0, target: 0 })
})

test('web search builds date-anchored and official-source queries', () => {
  const web = buildSearchQueries('OpenAI 最新模型', '2026-08-02')
  assert.equal(web.length, 2)
  assert.ok(web.every(query => query.includes('2026-08-02')))
  assert.ok(web[0].includes('最新进展'))
  assert.ok(web[1].includes('官方公告'))
})

test('search freshness maps explicit time intent to Tavily windows', () => {
  assert.equal(inferSearchTimeRange('今天 OpenAI 有什么新闻'), 'day')
  assert.equal(inferSearchTimeRange('本周 AI 更新'), 'week')
  assert.equal(inferSearchTimeRange('OpenAI 最新模型'), 'month')
  assert.equal(inferSearchTimeRange('牛顿第二定律'), null)
})
