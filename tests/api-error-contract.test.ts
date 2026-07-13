import assert from 'node:assert/strict'
import test from 'node:test'
import {
  API_ERROR_CODES,
  API_ERROR_CONTRACT_HEADER,
  API_ERROR_CONTRACT_VERSION,
  apiErrorEnvelopeV1,
  apiErrorResponseV1,
} from '../lib/api/errors'

test('v1 API errors have a stable machine-readable body and correlation headers', async () => {
  const request = new Request('https://mychat.example/v1/jobs', {
    headers: { 'x-request-id': 'request-1234' },
  })
  const response = apiErrorResponseV1(request, {
    status: 409,
    code: API_ERROR_CODES.JOB_LEASE_STALE,
    message: '任务租约已失效',
    retryable: false,
    details: { current_status: 'running' },
    headers: { 'Retry-After': '3', 'Cache-Control': 'public' },
  })

  assert.equal(response.status, 409)
  assert.equal(response.headers.get('x-request-id'), 'request-1234')
  assert.equal(response.headers.get(API_ERROR_CONTRACT_HEADER), API_ERROR_CONTRACT_VERSION)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('retry-after'), '3')
  assert.deepEqual(await response.json(), {
    error: {
      code: 'JOB_LEASE_STALE',
      message: '任务租约已失效',
      retryable: false,
      details: { current_status: 'running' },
    },
    request_id: 'request-1234',
  })
})

test('v1 API errors always generate a safe request id and empty details by default', () => {
  const body = apiErrorEnvelopeV1(undefined, {
    code: API_ERROR_CODES.INTERNAL_ERROR,
    message: '服务暂时不可用',
    retryable: true,
  })

  assert.match(body.request_id, /^[0-9a-f-]{36}$/)
  assert.deepEqual(body.error.details, {})
  assert.equal(JSON.stringify(body).includes('stack'), false)
})

test('untrusted request ids are replaced instead of reflected', async () => {
  const request = new Request('https://mychat.example/v1/jobs', {
    headers: { 'x-request-id': 'bad id with spaces' },
  })
  const response = apiErrorResponseV1(request, {
    status: 400,
    code: API_ERROR_CODES.INVALID_REQUEST,
    message: '请求无效',
    retryable: false,
  })
  const body = await response.json() as { request_id: string }

  assert.notEqual(body.request_id, 'bad id with spaces')
  assert.match(body.request_id, /^[0-9a-f-]{36}$/)
  assert.equal(response.headers.get('x-request-id'), body.request_id)
})
