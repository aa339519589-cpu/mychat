import type { JobHandler } from '../worker'
import { JobEventWriter } from '../event-writer'
import { loadChatJob } from './chat-input'
import { runChatMediaJob } from './chat-media'
import { runChatTextJob } from './chat-text'

export { handleLongThinkJob } from '@/lib/long-think/handler'

/**
 * Emit job.started before loadChatJob so connected SSE clients leave the
 * silent prep window immediately. loadChatJob + prepareChat can take hundreds
 * of ms of DB work; without an early event the UI stays blank until the first
 * text.delta (or a late job.snapshot on reconnect).
 */
export const handleChatGeneration: JobHandler = async context => {
  const writer = new JobEventWriter(context)
  try {
    await writer.append(
      'job.started',
      {
        type: context.job.type,
        attempt: context.job.attempt,
        phase: 'preparing',
      },
      `${context.job.id}:started-early:${context.fence.leaseVersion}`,
    )
  } finally {
    // Release the live channel so the text/media writer owns a clean publisher.
    await writer.closeLive()
  }

  const input = await loadChatJob(context.job)
  return input.command.outputKind === 'text'
    ? runChatTextJob(context, input)
    : runChatMediaJob(context, input)
}
