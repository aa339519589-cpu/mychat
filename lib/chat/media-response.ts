import type { ChatEvent } from '@/lib/llm/events'
import {
  generateOpenAICompatibleMedia,
  MediaGenerationError,
  type MediaOutputKind,
} from '@/lib/llm/media-generation'
import { done, networkError, send } from '@/lib/llm/stream'
import type { EndpointAuthType } from '@/lib/model-endpoints'
import { log } from '@/lib/logger'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  DEFAULT_DURABLE_RUNNER_DEPENDENCIES,
  initializeDurableGenerationRunner,
  type DurableRunnerDependencies,
} from '@/lib/generation/durable-runner'
import {
  terminalEventFromConfirmation,
  type TerminalPlan,
} from '@/lib/generation/terminal'
import type { GenerationTerminalEvent } from '@/lib/generation/types'
import {
  cleanupDurableGeneratedMediaUploads,
  DurableMediaStorageError,
  persistDurableGeneratedMedia,
  type DurableMediaPersistence,
} from '@/lib/generation/media-storage'

type MediaLog = {
  event: string
  fields: Record<string, unknown>
}

type MediaStreamEvent = ChatEvent
  | { heartbeat: true }
  | { generationId: string; assistantMessageId: string }
  | GenerationTerminalEvent

export async function createMediaGenerationResponse(options: {
  requestSignal: AbortSignal
  durable: {
    supabase: SupabaseClient | null
    userId: string | null
    generationId: string
    conversationId: string
    assistantMessageId: string
  }
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
  persistMedia?: typeof persistDurableGeneratedMedia
  cleanupMedia?: typeof cleanupDurableGeneratedMediaUploads
  runnerDependencies?: Partial<DurableRunnerDependencies>
}): Promise<Response> {
  const dependencies = {
    ...DEFAULT_DURABLE_RUNNER_DEPENDENCIES,
    ...options.runnerDependencies,
  }
  const initialized = await initializeDurableGenerationRunner(options.durable, dependencies)
  if (initialized.response) return initialized.response
  const runner = initialized.runner
  let clientConnected = true
  options.requestSignal.addEventListener('abort', () => {
    clientConnected = false
  }, { once: true })
  const stream = new ReadableStream({
    async start(controller) {
      const safeSend = (event: MediaStreamEvent) => {
        if (!clientConnected) return
        try { send(controller, event) } catch { clientConnected = false }
      }
      const heartbeat = setInterval(() => safeSend({ heartbeat: true }), 8_000)
      let terminalPlan: TerminalPlan = { status: 'failed', error: '媒体生成未完成' }
      let persisted: DurableMediaPersistence | null = null
      try {
        await runner.start()
        safeSend({
          generationId: options.durable.generationId,
          assistantMessageId: options.durable.assistantMessageId,
        })
        runner.appendThinking(options.thinking)
        safeSend({ thinking: options.thinking })
        if (options.startLog) log.info('chat', options.startLog.event, options.startLog.fields)
        runner.assertAuthority()
        const media = await (options.generateMedia ?? generateOpenAICompatibleMedia)({
          baseUrl: options.baseUrl,
          apiKey: options.apiKey,
          authType: options.authType,
          model: options.model,
          outputKind: options.outputKind,
          forceKind: options.forceKind,
          prompt: options.prompt,
          sourceImage: options.sourceImage,
          signal: runner.signal,
        })
        await runner.observeRemoteTerminal()
        runner.assertAuthority()
        if (options.durable.supabase && options.durable.userId) {
          persisted = await (options.persistMedia ?? persistDurableGeneratedMedia)({
            userId: options.durable.userId,
            conversationId: options.durable.conversationId,
            generationId: options.durable.generationId,
            baseUrl: options.baseUrl,
            apiKey: options.apiKey,
            authType: options.authType,
            signal: runner.signal,
          }, media)
        }
        await runner.observeRemoteTerminal()
        runner.assertAuthority()
        const durableMedia = persisted?.media ?? media
        runner.appendText(options.successText)
        terminalPlan = runner.resolveTerminal({ status: 'completed', media: [durableMedia] })
      } catch (error) {
        let message = error instanceof MediaGenerationError
          ? error.message
          : error instanceof DurableMediaStorageError
            ? error.message
          : networkError(error, '媒体生成服务', [options.apiKey])
        if (options.permissionError && /not enabled for this group|permission/i.test(message)) {
          message = options.permissionError
        }
        if (options.failureLog) {
          log.error('chat', options.failureLog.event, { ...options.failureLog.fields, message })
        }
        terminalPlan = runner.resolveTerminal({ status: 'failed', error: message })
      } finally {
        clearInterval(heartbeat)
        const confirmation = await runner.finalize(terminalPlan).catch(error => {
          log.error('generation', 'media terminal confirmation failed', {
            generationId: options.durable.generationId,
            name: error instanceof Error ? error.name : 'unknown',
          })
          return { confirmed: false as const }
        })
        const uploadIsCanonical = persisted && confirmation.confirmed
          && confirmation.status === 'completed'
          && confirmation.media.some(item => (
            item.type === persisted!.media.type && item.url === persisted!.media.url
          ))
        if (persisted && !uploadIsCanonical && options.durable.userId) {
          await (options.cleanupMedia ?? cleanupDurableGeneratedMediaUploads)({
            userId: options.durable.userId,
            conversationId: options.durable.conversationId,
            generationId: options.durable.generationId,
          }, [persisted.receipt]).catch(error => {
            log.error('generation', 'orphan media cleanup failed', {
              generationId: options.durable.generationId,
              name: error instanceof Error ? error.name : 'unknown',
            })
          })
        }
        if (confirmation.confirmed && confirmation.status === 'completed') {
          for (const media of confirmation.media) safeSend({ media })
          if (confirmation.content) safeSend({ text: confirmation.content })
        }
        const terminalEvent = terminalEventFromConfirmation(confirmation)
        if (terminalEvent) safeSend(terminalEvent)
        else safeSend({ error: '生成任务终态尚未确认，请重新载入会话' })
        if (clientConnected && terminalEvent) {
          try { done(controller) } catch { clientConnected = false }
        } else if (clientConnected) {
          try { controller.close() } catch { clientConnected = false }
        }
      }
    },
    cancel() {
      clientConnected = false
    },
  })
  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
  })
}
