/** Low-latency speech transport matching the mobile web client's Sarah voice. */
export const SARAH_VOICE_ID = 'EXAVITQu4vr4xnSDxMaL'
export const PCM_SAMPLE_RATE = 24_000
const MAX_AUDIO_BYTES = 20 * 1024 * 1024

type PCMOptions = {
  text: string
  apiKey: string
  signal: AbortSignal
  fetcher: typeof fetch
  firstAudioTimeoutMs?: number
}

export function speechSegments(text: string): string[] {
  const characters = Array.from(text.trim())
  const segments: string[] = []
  while (characters.length) {
    const limit = segments.length ? 800 : 96
    let end = Math.min(limit, characters.length)
    if (end < characters.length) {
      for (let i = end - 1; i >= 24; i--) {
        if (/[。！？.!?\n]/u.test(characters[i])) { end = i + 1; break }
      }
    }
    segments.push(characters.splice(0, end).join(''))
  }
  return segments
}

function requestSegment(text: string, options: PCMOptions, signal: AbortSignal): Promise<Response> {
  return options.fetcher(`https://api.elevenlabs.io/v1/text-to-speech/${SARAH_VOICE_ID}/stream?output_format=pcm_24000`, {
    method: 'POST',
    redirect: 'error',
    cache: 'no-store',
    signal,
    headers: { 'Content-Type': 'application/json', 'xi-api-key': options.apiKey },
    body: JSON.stringify({
      text,
      model_id: 'eleven_flash_v2_5',
      language_code: /\p{Script=Han}/u.test(options.text) ? 'zh' : undefined,
      voice_settings: { stability: 0.5, similarity_boost: 0.75, speed: 1 },
    }),
  })
}

async function audioReader(response: Response): Promise<ReadableStreamDefaultReader<Uint8Array>> {
  if (!response.ok || !response.body) {
    await response.body?.cancel()
    throw new Error(response.status === 402 || response.status === 429 ? '语音额度不足或请求过快' : '语音服务暂不可用')
  }
  const type = response.headers.get('content-type') || ''
  if (!type.startsWith('audio/') && !type.startsWith('application/octet-stream')) {
    await response.body.cancel()
    throw new Error('语音服务返回了无效音频')
  }
  return response.body.getReader()
}

async function nonemptyChunk(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<ReadableStreamReadResult<Uint8Array>> {
  for (;;) {
    const chunk = await reader.read()
    if (chunk.done || chunk.value.byteLength) return chunk
  }
}

type Prefetched = { reader?: ReadableStreamDefaultReader<Uint8Array>; error?: unknown }

/** Return after the first playable bytes, never after the whole utterance. */
export async function preparePCMStream(options: PCMOptions): Promise<ReadableStream<Uint8Array>> {
  const segments = speechSegments(options.text)
  if (!segments.length) throw new Error('朗读文本为空')
  const abort = new AbortController()
  const relayAbort = () => abort.abort(options.signal.reason)
  options.signal.addEventListener('abort', relayAbort, { once: true })
  if (options.signal.aborted) relayAbort()
  const deadline = setTimeout(() => abort.abort(new Error('语音首段返回超时')), options.firstAudioTimeoutMs ?? 3000)
  let reader: ReadableStreamDefaultReader<Uint8Array>
  let first: ReadableStreamReadResult<Uint8Array>
  try {
    reader = await audioReader(await requestSegment(segments[0], options, abort.signal))
    first = await nonemptyChunk(reader)
    if (first.done) throw new Error('语音服务返回了空音频')
    if (first.value.byteLength > MAX_AUDIO_BYTES) { await reader.cancel(); throw new Error('语音服务返回的音频过大') }
  } catch (error) {
    clearTimeout(deadline)
    abort.abort(error)
    options.signal.removeEventListener('abort', relayAbort)
    throw error
  }
  clearTimeout(deadline)
  return joinedStream({ options, segments, reader, first: first.value, abort, relayAbort })
}

type JoinedOptions = {
  options: PCMOptions
  segments: string[]
  reader: ReadableStreamDefaultReader<Uint8Array>
  first: Uint8Array
  abort: AbortController
  relayAbort: () => void
}

function joinedStream(state: JoinedOptions): ReadableStream<Uint8Array> {
  let index = 0, total = 0
  let reader = state.reader
  let next: Promise<Prefetched> | undefined
  const finish = () => {
    state.abort.abort()
    state.options.signal.removeEventListener('abort', state.relayAbort)
  }
  const prefetch = () => {
    const text = state.segments[index + 1]
    next = text ? requestSegment(text, state.options, state.abort.signal).then(audioReader)
      .then(reader => ({ reader }), error => ({ error })) : undefined
  }
  const emit = (controller: ReadableStreamDefaultController<Uint8Array>, value: Uint8Array) => {
    total += value.byteLength
    if (total > MAX_AUDIO_BYTES) throw new Error('语音服务返回的音频过大')
    controller.enqueue(value)
  }
  return new ReadableStream<Uint8Array>({
    start(controller) { emit(controller, state.first); prefetch() },
    async pull(controller) {
      try {
        await pullNext(controller)
      } catch (error) {
        finish()
        await reader.cancel(error).catch(() => undefined)
        controller.error(error)
      }
    },
    async cancel(reason) { finish(); await reader.cancel(reason).catch(() => undefined) },
  })

  async function pullNext(controller: ReadableStreamDefaultController<Uint8Array>) {
    let chunk = await nonemptyChunk(reader)
    while (chunk.done && next) {
      reader.releaseLock()
      const upcoming = await next
      if (!upcoming.reader) throw upcoming.error
      reader = upcoming.reader
      index++
      prefetch()
      chunk = await nonemptyChunk(reader)
    }
    if (chunk.done) { finish(); reader.releaseLock(); controller.close() }
    else emit(controller, chunk.value)
  }
}
