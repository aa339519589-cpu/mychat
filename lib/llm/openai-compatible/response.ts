import { isRecord } from '@/lib/unknown-value'
import {
  MAX_RESPONSE_BYTES,
  ModelEndpointError,
  type EndpointStage,
} from './contracts'

type LimitedTextOptions = {
  stage?: EndpointStage
  tooLargeMessage?: string
}

function responseTooLarge(options: LimitedTextOptions): never {
  throw new ModelEndpointError(
    options.tooLargeMessage ?? '模型服务响应过大',
    options.stage ?? 'models',
    'response_too_large',
    502,
  )
}

export async function readLimitedText(
  response: Response,
  options: LimitedTextOptions = {},
): Promise<string> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined)
    return responseTooLarge(options)
  }
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let bytes = 0
  let text = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined)
        return responseTooLarge(options)
      }
      text += decoder.decode(value, { stream: true })
    }
    return text + decoder.decode()
  } finally {
    reader.releaseLock()
  }
}

function redactUpstream(value: string, secrets: string[]): string {
  let safe = value
  for (const secret of secrets.map(item => item.trim()).filter(Boolean)) {
    safe = safe.split(secret).join('***')
  }
  return safe
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, '***')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .slice(0, 240)
}

function structuredUpstreamMessage(value: unknown): string {
  if (!isRecord(value)) return ''
  const error = isRecord(value.error) ? value.error : null
  const candidate = error?.message ?? value.message ?? value.detail
    ?? error?.code ?? value.code
  return typeof candidate === 'string' ? candidate : ''
}

export function upstreamMessage(raw: string, secrets: string[] = []): string {
  try {
    return redactUpstream(structuredUpstreamMessage(JSON.parse(raw)), secrets)
  } catch {
    return redactUpstream(raw, secrets)
  }
}
