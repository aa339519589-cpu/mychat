import assert from 'node:assert/strict'
import test from 'node:test'
import type { NextRequest } from 'next/server'
import { POST as chat } from '../app/api/chat/route'
import { POST as title } from '../app/api/chat/title/route'
import { POST as codeChat } from '../app/api/code/chat/route'
import { POST as codeApply } from '../app/api/code/apply/route'
import { POST as resumeJob } from '../app/api/v1/jobs/[jobId]/resume/route'

test('maintenance keeps chat admission online but rejects Agent and publication commands before auth or body parsing', { concurrency: false }, async t => {
  const previous = process.env.MYCHAT_MAINTENANCE_MODE
  process.env.MYCHAT_MAINTENANCE_MODE = 'drain'
  t.after(() => {
    if (previous === undefined) delete process.env.MYCHAT_MAINTENANCE_MODE
    else process.env.MYCHAT_MAINTENANCE_MODE = previous
  })

  for (const [path, route] of [
    ['/api/code/chat', codeChat],
    ['/api/code/apply', codeApply],
    ['/api/v1/jobs/89800000-0000-4000-8000-000000000002/resume', (request: NextRequest) => resumeJob(
      request,
      { params: Promise.resolve({ jobId: '89800000-0000-4000-8000-000000000002' }) },
    )],
  ] as const) {
    const request = new Request(`http://localhost${path}`, {
      method: 'POST',
      body: '{not-json',
      headers: { 'content-type': 'application/json' },
    }) as NextRequest
    const response = await route(request)
    const body = await response.json() as { error?: { code?: string; retryable?: boolean } }
    assert.equal(response.status, 503, path)
    assert.equal(response.headers.get('Retry-After'), '30', path)
    assert.deepEqual(body.error, {
      code: 'MAINTENANCE_MODE',
      message: '系统正在安全维护，暂不接受新的 Agent 或发布任务',
      retryable: true,
      details: {},
    }, path)
  }

  for (const path of ['/api/chat', '/api/chat/title']) {
    const request = new Request(`http://localhost${path}`, { method: 'POST' })
    const response = await (path === '/api/chat' ? chat : title)(request as NextRequest)
    assert.notEqual(response.headers.get('Retry-After'), '30', path)
  }
})
