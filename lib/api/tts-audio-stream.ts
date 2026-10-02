export async function prepareBoundedAudioStream(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<ReadableStream<Uint8Array>> {
  if (!body) throw new Error('语音服务没有返回音频流')

  const reader = body.getReader()
  let totalBytes = 0
  let firstChunk: Uint8Array

  try {
    const first = await reader.read()
    if (first.done || !first.value || first.value.byteLength === 0) {
      throw new Error('语音服务返回了空音频')
    }
    if (first.value.byteLength > maxBytes) {
      throw new Error('语音服务返回的音频过大')
    }
    firstChunk = first.value
    totalBytes = firstChunk.byteLength
  } catch (error) {
    await reader.cancel(error).catch(() => undefined)
    throw error
  }

  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(firstChunk)
    },
    async pull(controller) {
      try {
        const next = await reader.read()
        if (next.done) {
          controller.close()
          return
        }

        totalBytes += next.value.byteLength
        if (totalBytes > maxBytes) {
          const error = new Error('语音服务返回的音频过大')
          await reader.cancel(error).catch(() => undefined)
          controller.error(error)
          return
        }

        controller.enqueue(next.value)
      } catch (error) {
        controller.error(error)
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => undefined)
    },
  })
}
