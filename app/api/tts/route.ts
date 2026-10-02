import { NextRequest } from 'next/server'
import { apiErrorResponseV1 } from '@/lib/api/errors'
import { enforceRequestRateLimit, resolveAuth } from '@/lib/api/guard'
import { readJson, RequestError } from '@/lib/api/request'
import { prepareBoundedAudioStream } from '@/lib/api/tts-audio-stream'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const FISH_AUDIO_URL = 'https://api.fish.audio/v1/tts'
const REFERENCE_ID = '652f3d49b41e4e4b8ce3ca8ee2380bd5'
const MAX_TEXT_LENGTH = 50_000
const MAX_AUDIO_BYTES = 20 * 1024 * 1024

type TTSRequest = { text?: unknown }
type ParsedTTSRequest = { text: string }

function failure(
  request: NextRequest,
  status: number,
  code: 'INVALID_REQUEST' | 'PAYLOAD_TOO_LARGE' | 'AUTH_DEPENDENCY_UNAVAILABLE' | 'AUTH_REQUIRED' | 'DEPENDENCY_UNAVAILABLE',
  message: string,
  retryable: boolean,
): Response {
  return apiErrorResponseV1(request, { status, code, message, retryable })
}

async function parseTTSRequest(request: NextRequest): Promise<ParsedTTSRequest | Response> {
  let body: TTSRequest
  try {
    body = await readJson<TTSRequest>(request, { maxBytes: 256 * 1024 })
  } catch (error) {
    return failure(
      request,
      error instanceof RequestError ? error.status : 400,
      error instanceof RequestError && error.status === 413 ? 'PAYLOAD_TOO_LARGE' : 'INVALID_REQUEST',
      error instanceof Error ? error.message : '请求内容无效',
      false,
    )
  }

  const text = typeof body.text === 'string' ? body.text.trim() : ''
  if (!text || text.length > MAX_TEXT_LENGTH) {
    return failure(request, 400, 'INVALID_REQUEST', '朗读文本为空或过长', false)
  }
  return { text }
}

async function requestFishAudio(request: NextRequest, text: string, apiKey: string): Promise<Response> {
  const providerTimeout = AbortSignal.timeout(60_000)
  const signal = AbortSignal.any([request.signal, providerTimeout])

  try {
    const providerResponse = await fetch(FISH_AUDIO_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        model: 's2.1-pro-free',
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify({
        text,
        reference_id: REFERENCE_ID,
        format: 'mp3',
        chunk_length: 100,
        latency: 'low',
      }),
      cache: 'no-store',
      signal,
    })

    if (!providerResponse.ok) {
      return failure(request, 502, 'DEPENDENCY_UNAVAILABLE', '语音生成失败，请稍后重试', true)
    }

    const contentType = providerResponse.headers.get('content-type')?.toLowerCase() ?? ''
    const declaredAudioLength = Number(providerResponse.headers.get('content-length'))
    if (!contentType.startsWith('audio/')
      || (Number.isFinite(declaredAudioLength) && declaredAudioLength > MAX_AUDIO_BYTES)) {
      return failure(request, 502, 'DEPENDENCY_UNAVAILABLE', '语音服务返回了无效音频', true)
    }

    let audioStream: ReadableStream<Uint8Array>
    try {
      audioStream = await prepareBoundedAudioStream(providerResponse.body, MAX_AUDIO_BYTES)
    } catch {
      return failure(request, 502, 'DEPENDENCY_UNAVAILABLE', '语音服务返回了无效音频', true)
    }

    return new Response(audioStream, {
      status: 200,
      headers: {
        'Content-Type': 'audio/mpeg',
        'Cache-Control': 'no-store, no-transform',
        'X-Accel-Buffering': 'no',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  } catch {
    const timedOut = providerTimeout.aborted
    return failure(
      request,
      timedOut ? 504 : 502,
      'DEPENDENCY_UNAVAILABLE',
      timedOut ? '语音生成超时，请重试' : '语音服务暂时不可用',
      true,
    )
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  const auth = await resolveAuth(request)
  if (auth.authUnavailable) return failure(request, 503, 'AUTH_DEPENDENCY_UNAVAILABLE', '认证服务暂时不可用', true)

  const rateGate = await enforceRequestRateLimit(auth, request)
  if (rateGate.response) return rateGate.response
  if (!auth.userId) return failure(request, 401, 'AUTH_REQUIRED', '请先登录后再朗读', false)

  const parsed = await parseTTSRequest(request)
  if (parsed instanceof Response) return parsed

  const apiKey = process.env.FISH_AUDIO_API_KEY?.trim()
  if (!apiKey) return failure(request, 503, 'DEPENDENCY_UNAVAILABLE', '语音服务暂时不可用', true)

  return requestFishAudio(request, parsed.text, apiKey)
}
