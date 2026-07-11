export type ChatStreamFinalization =
  | { kind: "persist"; warning?: string }
  | { kind: "remove" }
  | { kind: "error"; message: string }

export function planChatStreamFinalization(input: {
  hasOutput: boolean
  aborted: boolean
  terminalError: string | null
}): ChatStreamFinalization {
  if (input.hasOutput) {
    return input.terminalError && !input.aborted
      ? { kind: "persist", warning: `生成提前结束：${input.terminalError}` }
      : { kind: "persist" }
  }
  if (input.aborted) return { kind: "remove" }
  return {
    kind: "error",
    message: input.terminalError || "模型没有返回可显示的内容，请重试。",
  }
}
