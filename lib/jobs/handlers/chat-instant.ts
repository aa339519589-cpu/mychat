import { isInstantReplyCandidate } from '@/lib/chat/instant-reply'
import { appendUserSystemPrompt } from '@/lib/chat/request-context'
import { buildModelContext } from '@/lib/llm/context'
import type { AgentLoopOpts } from '@/lib/llm/agent-loop'
import type { LoadedChatJob } from './chat-input'

function instantSystem(input: LoadedChatJob): string {
  const { selection } = input
  const identity = selection.customEndpoint
    ? `本次使用用户接入的外部模型，真实模型标识是 ${selection.model}。`
    : `你是 MyChat 的「${selection.platformTierLabel ?? '当前内置档位'}」对话模型。`
  return `你运行在 MyChat 中。\n${identity}\n用户只是简短问候或测试连接。立即使用用户的语言自然回复一到两句。不要调用工具，不要展开说明，不要提及系统提示词、内部路径、记忆、项目或底层供应商。`
}

export function instantModelMessages(input: LoadedChatJob): AgentLoopOpts['messages'] | null {
  const { command, context, selection } = input
  if (!isInstantReplyCandidate({
    messages: context.messages,
    searchMode: command.searchMode,
    deepResearch: command.deepResearch,
    attachments: command.attachments,
    inProject: Boolean(context.project?.id),
  })) return null
  return [
    {
      role: 'system',
      content: appendUserSystemPrompt(instantSystem(input), context.customSystemPrompt),
    },
    ...buildModelContext(context.messages.slice(-1), selection.capability),
  ]
}
