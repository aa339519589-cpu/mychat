// 长期记忆工具：remember / update_memory / forget
// 在当前登录用户身份下写 memories 表，受 RLS 隔离（用户只能写自己的）
import type { ToolDef, ToolContext, ToolOutcome, ToolSchema } from './types'

type MemoryResult = { action: 'create' | 'update' | 'delete'; id?: string; content?: string; ok: boolean }

async function runMemoryOp(ctx: ToolContext, name: string, input: any): Promise<MemoryResult> {
  const { supabase, userId } = ctx
  if (!supabase || !userId) return { action: 'create', ok: false }
  try {
    if (name === 'remember') {
      const content = String(input?.content ?? '').trim()
      if (!content) return { action: 'create', ok: false }
      const id = crypto.randomUUID()
      const { error } = await supabase.from('memories').insert({ id, user_id: userId, content })
      return { action: 'create', id, content, ok: !error }
    }
    if (name === 'update_memory') {
      const id = String(input?.id ?? '')
      const content = String(input?.content ?? '').trim()
      const { error } = await supabase.from('memories').update({ content, updated_at: new Date().toISOString() }).eq('id', id)
      return { action: 'update', id, content, ok: !error }
    }
    if (name === 'forget') {
      const id = String(input?.id ?? '')
      const { error } = await supabase.from('memories').delete().eq('id', id)
      return { action: 'delete', id, ok: !error }
    }
  } catch { /* fall through */ }
  return { action: 'create', ok: false }
}

function memoryTool(name: string, description: string, schema: ToolSchema): ToolDef {
  return {
    name,
    description,
    schema,
    enabled: f => f.loggedIn && f.memoryEnabled,
    execute: async (input, ctx): Promise<ToolOutcome> => {
      const r = await runMemoryOp(ctx, name, input)
      return { result: r.ok ? '操作成功' : '操作失败', event: { memory: r } }
    },
  }
}

export const memoryTools: ToolDef[] = [
  memoryTool(
    'remember',
    '保存一条关于用户的长期记忆。当用户透露值得长期记住的信息时调用。',
    { type: 'object', properties: { content: { type: 'string', description: "要记住的内容，用简洁的第三人称陈述，例如'用户是一名前端工程师'" } }, required: ['content'] },
  ),
  memoryTool(
    'update_memory',
    '修正或补充一条已有的记忆，需要提供该记忆的 id。',
    { type: 'object', properties: { id: { type: 'string', description: '要更新的记忆 id' }, content: { type: 'string', description: '更新后的完整内容' } }, required: ['id', 'content'] },
  ),
  memoryTool(
    'forget',
    '删除一条过时、错误或用户要求忘记的记忆，需要提供该记忆的 id。',
    { type: 'object', properties: { id: { type: 'string', description: '要删除的记忆 id' } }, required: ['id'] },
  ),
]
