import assert from 'node:assert/strict'
import test from 'node:test'
import { generationTerminalWarning } from '@/lib/generation-message'
import { retryableTurnStatus } from '@/lib/llm/turn'

test('retries only transient provider response statuses', () => {
  for (const status of [408, 425, 429, 500, 502, 503, 504]) {
    assert.equal(retryableTurnStatus(status), true, String(status))
  }
  for (const status of [200, 400, 401, 403, 404, 409, 422]) {
    assert.equal(retryableTurnStatus(status), false, String(status))
  }
})

test('does not expose internal job errors in chat history', () => {
  assert.equal(generationTerminalWarning({
    id: 'generation-1',
    status: 'failed',
    sequence: 3,
    error: 'JOB_ATTEMPTS_EXHAUSTED',
  }), '这次回复没有生成成功，请点击重新生成')

  assert.equal(generationTerminalWarning({
    id: 'generation-2',
    status: 'failed',
    sequence: 4,
    error: '作业控制面暂时不可用',
  }), '这次回复没有生成成功，请点击重新生成')
})
