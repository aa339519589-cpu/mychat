import { MAX_RESPONSE_BYTES, ModelEndpointError } from './contracts'

export async function readLimitedText(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined)
    throw new ModelEndpointError('模型服务响应过大', 'models', 'response_too_large', 502)
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
        throw new ModelEndpointError('模型服务响应过大', 'models', 'response_too_large', 502)
      }
      text += decoder.decode(value, { stream: true })
    }
    return text + decoder.decode()
  } finally {
    reader.releaseLock()
  }
}

export function upstreamMessage(raw: string, secrets: string[] = []): string {
  try {
    const parsed = JSON.parse(raw)
    const message = parsed?.error?.message ?? parsed?.message
    if (typeof message !== 'string') return ''
    let safe = message
    for (const secret of secrets.map(item => item.trim()).filter(Boolean)) {
      safe = safe.split(secret).join('***')
    }
    return safe.replace(/sk-[A-Za-z0-9_-]{8,}/g, '***').slice(0, 180)
  } catch {
    return ''
  }
}
