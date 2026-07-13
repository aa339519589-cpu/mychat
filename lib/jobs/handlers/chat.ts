import type { JobHandler } from '../worker'
import { loadChatJob } from './chat-input'
import { runChatMediaJob } from './chat-media'
import { runChatTextJob } from './chat-text'

export const handleChatGeneration: JobHandler = async context => {
  const input = await loadChatJob(context.job)
  return input.command.outputKind === 'text'
    ? runChatTextJob(context, input)
    : runChatMediaJob(context, input)
}
