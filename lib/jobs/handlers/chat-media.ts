import { extractImagePrompt } from '@/lib/image-intent'
import { latestUserPrompt, latestUserSourceImages } from '@/lib/chat/request-context'
import {
  resolveDeepTierImageConfig,
  resolveDeepTierVideoConfig,
} from '@/lib/llm/models'
import {
  generateOpenAICompatibleMedia,
  MediaGenerationError,
  type GeneratedMedia,
  type MediaOutputKind,
} from '@/lib/llm/media-generation'
import {
  cleanupDurableGeneratedMediaUploads,
  DurableMediaStorageError,
  persistDurableGeneratedMedia,
  type DurableMediaPersistence,
} from '@/lib/generation/media-storage'
import type { EndpointAuthType } from '@/lib/model-endpoints'
import type { LoadedChatJob } from './chat-input'
import type { JobExecutionContext, JobHandlerResult } from '../worker'
import { JobEventWriter, jsonResult } from '../event-writer'
import { executeFencedToolEffect } from '../tool-effects'
import { jobAssetUploadLifecycle } from '../assets'
import { JobRuntimeError } from '../errors'
import { platformMediaUsage } from '../pricing'

type MediaTransport = {
  baseUrl: string
  apiKey: string
  authType: EndpointAuthType
  model: string
  outputKind: MediaOutputKind
  forceKind?: MediaOutputKind
}

type ChatMediaDependencies = {
  generateMedia: typeof generateOpenAICompatibleMedia
  persistMedia: typeof persistDurableGeneratedMedia
  cleanupMedia: typeof cleanupDurableGeneratedMediaUploads
}

const DEFAULT_DEPENDENCIES: ChatMediaDependencies = {
  generateMedia: generateOpenAICompatibleMedia,
  persistMedia: persistDurableGeneratedMedia,
  cleanupMedia: cleanupDurableGeneratedMediaUploads,
}

function transport(input: LoadedChatJob): MediaTransport {
  const kind = input.command.outputKind
  if (kind !== 'image' && kind !== 'video') {
    throw new JobRuntimeError('JOB_INVALID_INPUT', 'Media job output kind is invalid')
  }
  if (input.selection.customEndpoint) return {
    baseUrl: input.selection.capability.provider.baseUrl,
    apiKey: input.selection.apiKey,
    authType: input.selection.authType ?? 'bearer',
    model: input.selection.model,
    outputKind: kind,
  }
  const config = kind === 'image' ? resolveDeepTierImageConfig() : resolveDeepTierVideoConfig()
  if (!config) throw new JobRuntimeError(
    'JOB_DEPENDENCY_UNAVAILABLE',
    kind === 'image' ? 'Platform image generation is not configured' : 'Platform video generation is not configured',
  )
  return { ...config, outputKind: kind, forceKind: kind }
}

function parsedMedia(value: string): GeneratedMedia {
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch {
    throw new JobRuntimeError('JOB_DEPENDENCY_UNAVAILABLE', 'Stored media provider result is malformed')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new JobRuntimeError('JOB_DEPENDENCY_UNAVAILABLE', 'Stored media provider result is malformed')
  }
  const row = parsed as Record<string, unknown>
  if ((row.type !== 'image' && row.type !== 'video') || typeof row.url !== 'string') {
    throw new JobRuntimeError('JOB_DEPENDENCY_UNAVAILABLE', 'Stored media provider result is malformed')
  }
  return parsed as GeneratedMedia
}

function parsedPersistence(value: string): DurableMediaPersistence {
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch {
    throw new JobRuntimeError('JOB_DEPENDENCY_UNAVAILABLE', 'Stored media upload result is malformed')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new JobRuntimeError('JOB_DEPENDENCY_UNAVAILABLE', 'Stored media upload result is malformed')
  }
  const row = parsed as Record<string, unknown>
  const media = row.media as Record<string, unknown> | undefined
  const receipt = row.receipt as Record<string, unknown> | undefined
  if (!media || (media.type !== 'image' && media.type !== 'video') || typeof media.url !== 'string'
    || receipt?.bucket !== 'generated-media' || typeof receipt.objectKey !== 'string') {
    throw new JobRuntimeError('JOB_DEPENDENCY_UNAVAILABLE', 'Stored media upload result is malformed')
  }
  return parsed as DurableMediaPersistence
}

export async function runChatMediaJob(
  context: JobExecutionContext,
  input: LoadedChatJob,
  dependencyOverrides: Partial<ChatMediaDependencies> = {},
): Promise<JobHandlerResult> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides }
  const writer = new JobEventWriter(context)
  const config = transport(input)
  const rawPrompt = latestUserPrompt(input.context.messages)
  const prompt = input.selection.customEndpoint ? rawPrompt : extractImagePrompt(rawPrompt)
  const sourceImage = latestUserSourceImages(input.context.messages)[0]
  const usage = platformMediaUsage(config.outputKind, input.selection.customEndpoint)
  if (!prompt && !sourceImage) throw new JobRuntimeError(
    'JOB_INVALID_INPUT',
    config.outputKind === 'image' ? '请输入图片描述，或附上参考图' : '请输入视频描述，或附上参考图',
  )
  const thinking = sourceImage
    ? config.outputKind === 'image' ? '正在根据参考图生成图片……' : '正在根据参考图生成视频……'
    : config.outputKind === 'image' ? '正在生成图片……' : '正在生成视频，这可能需要几分钟……'
  writer.emit({ thinking })
  let persisted: DurableMediaPersistence | null = null
  try {
    await writer.append('job.started', {
      type: context.job.type,
      attempt: context.job.attempt,
      model: config.model,
    }, `${context.job.id}:started:${context.fence.leaseVersion}`)
    await writer.checkpoint({
      phase: 'media.provider_request',
      data: { schemaVersion: 1, stage: 'provider_request' },
      resumable: true,
    })
    context.budget.consumeToolCall()
    const providerEffect = await executeFencedToolEffect({
      client: input.client,
      fence: context.fence,
      toolCallId: 'media-provider-create',
      toolName: 'media.generate',
      args: { model: config.model, outputKind: config.outputKind, prompt, hasSourceImage: Boolean(sourceImage) },
      replaySafe: true,
      execute: async () => JSON.stringify(await dependencies.generateMedia({
        ...config,
        prompt,
        sourceImage,
        signal: context.signal,
        idempotencyKey: `${context.job.id}:media:create`,
      })),
    })
    context.assertAuthority()
    const generated = parsedMedia(providerEffect.result)
    context.reportAccounting({
      idempotencyKey: `${context.job.id}:media-usage`,
      reason: input.selection.customEndpoint ? 'custom_media_usage' : 'platform_media_usage',
      direction: 'debit',
      weightedTokens: usage.weightedTokens,
      rawTokens: 0,
      model: config.model,
      provider: input.selection.capability.provider.id,
      costMicros: usage.costMicros,
      currency: 'USD',
      metadata: {
        outputKind: config.outputKind,
        usingBalance: input.command.usingBalance,
        providerResultReplayed: providerEffect.replayed,
        priceVersion: usage.priceVersion,
      },
    })
    await writer.checkpoint({
      phase: 'media.storage_upload',
      data: {
        schemaVersion: 1,
        stage: 'storage_upload',
        providerResultReplayed: providerEffect.replayed,
      },
      resumable: true,
    })
    context.budget.consumeToolCall()
    const storageEffect = await executeFencedToolEffect({
      client: input.client,
      fence: context.fence,
      toolCallId: 'media-storage-upload',
      toolName: 'media.persist',
      args: generated,
      replaySafe: false,
      execute: async () => JSON.stringify(await dependencies.persistMedia({
        userId: input.userId,
        conversationId: input.conversationId,
        generationId: context.job.id,
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        authType: config.authType,
        signal: context.signal,
      }, generated, {
        ...jobAssetUploadLifecycle({
          client: input.client,
          fence: context.fence,
          principalId: input.userId,
        }),
      })),
    })
    persisted = parsedPersistence(storageEffect.result)
    writer.emit({ text: config.outputKind === 'image' ? '图片已生成。' : '视频已生成。' })
    await writer.drain()
    context.assertAuthority()
    return {
      status: 'completed',
      result: jsonResult({
        schemaVersion: 1,
        content: writer.text(),
        thinking: writer.thinking(),
        media: [persisted.media],
        mediaRefs: [persisted.media],
        assetObjectKeys: [persisted.receipt.objectKey],
        irreversibleCommitted: true,
        model: config.model,
      }),
      ledgerEntries: [{
        idempotencyKey: `${context.job.id}:media-usage`,
        reason: input.selection.customEndpoint ? 'custom_media_usage' : 'platform_media_usage',
        direction: 'debit',
        weightedTokens: usage.weightedTokens,
        rawTokens: 0,
        model: config.model,
        provider: input.selection.capability.provider.id,
        costMicros: usage.costMicros,
        currency: 'USD',
        metadata: {
          outputKind: config.outputKind,
          usingBalance: input.command.usingBalance,
          providerResultReplayed: providerEffect.replayed,
          priceVersion: usage.priceVersion,
        },
      }],
    }
  } catch (error) {
    if (persisted) await dependencies.cleanupMedia({
      userId: input.userId,
      conversationId: input.conversationId,
      generationId: context.job.id,
    }, [persisted.receipt]).catch(() => undefined)
    if (error instanceof JobRuntimeError) throw error
    if (context.signal.aborted) throw context.signal.reason
    const message = error instanceof MediaGenerationError || error instanceof DurableMediaStorageError
      ? error.message
      : 'Media generation dependency failed'
    throw new JobRuntimeError('JOB_DEPENDENCY_UNAVAILABLE', message, {
      class: error instanceof MediaGenerationError ? 'provider' : 'internal',
      cause: error,
    })
  }
}
