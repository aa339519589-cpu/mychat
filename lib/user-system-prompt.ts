export const MAX_CUSTOM_SYSTEM_PROMPT_CHARS = 20_000

export function normalizeCustomSystemPrompt(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, MAX_CUSTOM_SYSTEM_PROMPT_CHARS)
}

function escapePromptXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

export function appendUserSystemPrompt(system: string, value: unknown): string {
  const prompt = normalizeCustomSystemPrompt(value)
  if (!prompt) return system
  return `${system}
---
【用户自定义系统提示词（高优先级附加指令）】
以下内容由当前用户在 MyChat 设置中填写，并位于 MyChat 后台系统规则之后。
在不与前述后台系统规则、安全边界和工具约束冲突的前提下，必须严格执行，不得擅自忽略、弱化或改写。
若发生冲突，前述后台系统规则优先；其余情况下，以该提示词约束本次回复。
<user_system_prompt>
${escapePromptXml(prompt)}
</user_system_prompt>`
}
