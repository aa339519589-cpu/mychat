// 长期记忆工具：remember / update_memory / forget
// 在项目内 → 写 project_memories 表（按 project_id 隔离）
// 在主聊天 → 写全局 memories 表（按 user_id 隔离）
import type { ToolDef, ToolContext, ToolOutcome, ToolSchema } from './types'
import { log } from '@/lib/logger'

type MemoryResult = { action: 'create' | 'update' | 'delete'; id?: string; content?: string; ok: boolean; timestamp?: string }

async function runMemoryOp(ctx: ToolContext, name: string, input: any): Promise<MemoryResult> {
  const { supabase, userId, projectId } = ctx
  if (!supabase || !userId) return { action: 'create', ok: false }
  // 有 projectId → 写项目记忆表；否则写全局记忆表
  const table = projectId ? 'project_memories' : 'memories'
  try {
    if (name === 'remember') {
      const content = String(input?.content ?? '').trim()
      if (!content) return { action: 'create', ok: false }
      const id = crypto.randomUUID()
      const ts = new Date().toISOString()
      const row: Record<string, unknown> = { id, user_id: userId, content }
      if (projectId) row.project_id = projectId
      const { error } = await supabase.from(table).insert(row)
      if (error) log.error('memory', `remember 写入失败 (${table})`, error)
      else log.info('memory', `remember 成功`, { table, projectId: projectId ?? null })
      return { action: 'create', id, content, ok: !error, timestamp: ts }
    }
    if (name === 'update_memory') {
      const id = String(input?.id ?? '')
      const content = String(input?.content ?? '').trim()
      const ts = new Date().toISOString()
      const { error } = await supabase.from(table).update({ content, updated_at: ts }).eq('id', id)
      if (error) log.error('memory', `update 失败 (${table})`, error)
      return { action: 'update', id, content, ok: !error, timestamp: ts }
    }
    if (name === 'forget') {
      const id = String(input?.id ?? '')
      const { error } = await supabase.from(table).delete().eq('id', id)
      if (error) log.error('memory', `forget 失败 (${table})`, error)
      return { action: 'delete', id, ok: !error }
    }
  } catch (e) {
    log.error('memory', `${name} 异常`, e)
  }
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
    '保存一条关于用户的长期记忆。在项目内调用时，记忆仅保存在本项目，不影响全局记忆；在主聊天调用时保存为全局记忆。',
    { type: 'object', properties: { content: { type: 'string', description: "要记住的内容，用简洁的第三人称陈述，例如'用户是一名前端工程师'" } }, required: ['content'] },
  ),
  memoryTool(
    'update_memory',
    '修正或补充一条已有的记忆，需要提供该记忆的 id。在项目内调用时修改该项目的记忆，在主聊天调用时修改全局记忆。',
    { type: 'object', properties: { id: { type: 'string', description: '要更新的记忆 id' }, content: { type: 'string', description: '更新后的完整内容' } }, required: ['id', 'content'] },
  ),
  memoryTool(
    'forget',
    '删除一条过时、错误或用户要求忘记的记忆，需要提供该记忆的 id。在项目内调用时删除该项目的记忆，在主聊天调用时删除全局记忆。',
    { type: 'object', properties: { id: { type: 'string', description: '要删除的记忆 id' } }, required: ['id'] },
  ),
]
