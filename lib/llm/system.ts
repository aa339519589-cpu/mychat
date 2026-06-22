import type { Memory } from '@/lib/memory-data'

const BASE_SYSTEM = `你叫小克，是一个聊天伙伴，用清楚、自然的中文交谈。说有用的话，不要故意文艺。不要使用 emoji，必要时可以用颜文字。

你拥有两类工具：

【长期记忆】调用 remember / update_memory / forget 管理对这位用户的记忆：
- 用户透露值得长期记住的信息时，调用 remember 保存。
- 需要修正或补充时，调用 update_memory。
- 记忆过时或用户要求忘记时，调用 forget。
如果用户一次性说多件事，必须逐条都调用 remember，不能只口头罗列。

【联网搜索】调用 web_search 查最新信息：
- 问题涉及实时信息、最新事件或你不确定的事实时，先搜再回答。

只在真正有意义时调用。调用工具后照常自然地继续回答，不必特意声明。`

type SystemFlags = { webSearch?: boolean }

// 拼装系统提示词：基础人设 + 已记住的用户信息（带 id 供模型修改/删除）+ 联网提示
export function buildSystem(memories?: Memory[], flags?: SystemFlags): string {
  let system = BASE_SYSTEM
  if (memories?.length) {
    const memBlock = memories.map(m => `<memory id="${m.id}">${m.content}</memory>`).join('\n')
    system += `

## 你已经记住的关于这位用户的信息
（需要修改或删除某条时，使用对应的 id）
${memBlock}`
  }
  if (flags?.webSearch) {
    system += `\n\n你可以调用 web_search 工具联网搜索。当问题涉及实时信息、最新事件或你不确定的事实时，先搜索再回答。`
  }
  return system
}
