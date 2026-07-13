import type { ChatEvent } from '@/lib/llm/events'
import {
  combineMediaGenerationSignals,
  generateOpenAICompatibleMedia,
  MediaGenerationError,
  type MediaOutputKind,
} from '@/lib/llm/media-generation'
import { done, networkError, send } from '@/lib/llm/stream'
import type { EndpointAuthType } from '@/lib/model-endpoints'
import { log } from '@/lib/logger'

type MediaLog = {
  event: string
  fields: Record<string, unknown>
}

export function createMediaGenerationResponse(options: {
  requestSignal: AbortSignal
  baseUrl: string
  apiKey: string
  authType: EndpointAuthType
  model: string
  outputKind: MediaOutputKind
  forceKind?: MediaOutputKind
  prompt: string
  sourceImage?: string
  thinking: string
  successText: string
  permissionError?: string
  startLog?: MediaLog
  failureLog?: MediaLog
  generateMedia?: typeof generateOpenAICompatibleMedia
}): Response {
  let clientConnected = true
  const mediaAbort = new AbortController()
  const mediaSignal = combineMediaGenerationSignals(options.requestSignal, mediaAbort.signal)
  const stream = new ReadableStream({
    async start(controller) {
      const safeSend = (event: ChatEvent | { heartbeat: true }) => {
        if (!clientConnected) return
        try { send(controller, event) } catch {
          clientConnected = false
          mediaAbort.abort(new DOMException('Media stream closed', 'AbortError'))
        }
      }
      const heartbeat = setInterval(() => safeSend({ heartbeat: true }), 8_000)
      try {
        safeSend({ thinking: options.thinking })
        if (options.startLog) log.info('chat', options.startLog.event, options.startLog.fields)
        const media = await (options.generateMedia ?? generateOpenAICompatibleMedia)({
          baseUrl: options.baseUrl,
          apiKey: options.apiKey,
          authType: options.authType,
          model: options.model,
          outputKind: options.outputKind,
          forceKind: options.forceKind,
          prompt: options.prompt,
          sourceImage: options.sourceImage,
          signal: mediaSignal,
        })
        safeSend({ media })
        safeSend({ text: options.successText })
      } catch (error) {
        let message = error instanceof MediaGenerationError
          ? error.message
          : networkError(error, '媒体生成服务', [options.apiKey])
        if (options.permissionError && /not enabled for this group|permission/i.test(message)) {
          message = options.permissionError
        }
        if (options.failureLog) {
          log.error('chat', options.failureLog.event, { ...options.failureLog.fields, message })
        }
        safeSend({ error: message })
      } finally {
        clearInterval(heartbeat)
        if (clientConnected) {
          try { done(controller) } catch { clientConnected = false }
        }
      }
    },
    cancel() {
      clientConnected = false
      mediaAbort.abort(new DOMException('Media stream cancelled', 'AbortError'))
    },
  })
  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
  })
}
