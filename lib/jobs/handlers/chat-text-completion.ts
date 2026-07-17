import { JobRuntimeError } from '../errors'
import { jsonResult } from '../event-writer'
import type { JobExecutionContext, JobHandlerResult } from '../worker'
import type { LoadedChatJob } from './chat-input'
import {
  cleanupChatInlineMedia,
  persistChatInlineMedia,
} from './chat-media-persistence'
import type { ChatTextDependencies, ChatTextRuntime } from './chat-text'
import { chatTokenAccounting } from './chat-text-runtime'

export async function completeChatTextRun(
  context: JobExecutionContext,
  input: LoadedChatJob,
  runtime: ChatTextRuntime,
  dependencies: ChatTextDependencies,
): Promise<JobHandlerResult> {
  await runtime.writer.drain()
  context.assertAuthority()
  if (runtime.pendingMedia.length) {
    runtime.persistedMedia = await persistChatInlineMedia(
      context,
      input,
      runtime.pendingMedia,
      dependencies,
    )
  }
  context.assertAuthority()
  const media = runtime.persistedMedia?.media ?? []
  return {
    status: 'completed',
    result: jsonResult({
      schemaVersion: 1,
      content: runtime.writer.text(),
      thinking: runtime.writer.thinking(),
      media,
      mediaRefs: media,
      assetObjectKeys: runtime.persistedMedia?.receipts.map(receipt => receipt.objectKey) ?? [],
      irreversibleCommitted: Boolean(media.length),
      model: input.selection.model,
      totalTokens: runtime.totalTokens,
    }),
    ledgerEntries: chatTokenAccounting(input, context.job.id, runtime.attemptTokens),
  }
}

export async function rethrowChatTextFailure(
  error: unknown,
  context: JobExecutionContext,
  input: LoadedChatJob,
  runtime: ChatTextRuntime,
  dependencies: ChatTextDependencies,
): Promise<never> {
  if (runtime.persistedMedia) {
    await cleanupChatInlineMedia(
      context,
      input,
      runtime.persistedMedia,
      dependencies,
    ).catch(() => undefined)
  }
  if (error instanceof JobRuntimeError) throw error
  if (context.signal.aborted) throw context.signal.reason
  throw new JobRuntimeError('JOB_DEPENDENCY_UNAVAILABLE', 'Chat generation dependency failed', {
    class: 'provider',
    cause: error,
  })
}
