// 记忆工具：两套独立系统
// ① 全局记忆（主聊天）：remember / update_memory / forget → 写 memories 表
// ② 项目记忆（项目内）：remember_project / update_project_memory / forget_project → 写 project_memories 表
import type { ToolDef, ToolContext, ToolOutcome, ToolSchema } from './types'
import { log } from '@/lib/logger'
import type { SupabaseClient } from '@/lib/supabase/types'
import { isRecord } from '@/lib/unknown-value'

type MemoryResult = { action: 'create' | 'update' | 'delete' | 'duplicate'; id?: string; content?: string; ok: boolean; timestamp?: string }

// ── 去重工具 ──
// 用字符级 2-gram Jaccard 相似度做轻量去重，无需嵌入模型。
// 中文按字符切分，英文/数字自然被 2-gram 覆盖。
function charBigramJaccard(a: string, b: string): number {
  if (!a || !b) return 0
  const bigramsA = new Set<string>()
  const bigramsB = new Set<string>()
  for (let i = 0; i < a.length - 1; i++) bigramsA.add(a.slice(i, i + 2))
  for (let i = 0; i < b.length - 1; i++) bigramsB.add(b.slice(i, i + 2))
  if (bigramsA.size === 0 && bigramsB.size === 0) return 0
  const intersection = new Set([...bigramsA].filter(x => bigramsB.has(x)))
  const union = new Set([...bigramsA, ...bigramsB])
  return intersection.size / union.size
}

const DEDUP_THRESHOLD = 0.55  // Jaccard > 0.55 → 判定为重复/高度相似
const MAX_MEMORY_CHARS = 5000
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
type MemoryTable = 'memories' | 'project_memories'

// 查询已有记忆，如果有高度相似的则返回那条记忆（用于更新），否则返回 null
async function findSimilarMemory(
  supabase: SupabaseClient, table: MemoryTable, userId: string, content: string, projectId?: string | null,
): Promise<{ id: string; content: string } | null> {
  try {
    const result = table === 'project_memories'
      ? projectId
        ? await supabase.from('project_memories').select('id, content')
            .eq('user_id', userId).eq('project_id', projectId)
        : null
      : await supabase.from('memories').select('id, content').eq('user_id', userId)
    if (!result) return null
    const { data } = result
    if (!Array.isArray(data) || !data.length) return null
    let best: { id: string; content: string; score: number } | null = null
    for (const rawRow of data) {
      if (!isRecord(rawRow) || typeof rawRow.id !== 'string' || typeof rawRow.content !== 'string') continue
      const score = charBigramJaccard(content, rawRow.content)
      if (score > DEDUP_THRESHOLD && (!best || score > best.score)) {
        best = { id: rawRow.id, content: rawRow.content, score }
      }
    }
    return best ?? null
  } catch {
    return null  // 查询失败不阻塞记忆操作
  }
}

async function runMemoryOp(ctx: ToolContext, opName: string, table: MemoryTable, input: unknown): Promise<MemoryResult> {
  const { supabase, userId, projectId } = ctx
  if (!supabase || !userId) return { action: 'create', ok: false }
  const params = isRecord(input) ? input : {}
  try {
    if (opName === 'remember' || opName === 'remember_project') {
      const content = String(params.content ?? '').trim()
      if (!content || content.length > MAX_MEMORY_CHARS) return { action: 'create', ok: false }
      if (table === 'project_memories' && !projectId) return { action: 'create', ok: false }
      const ts = new Date().toISOString()

      // 去重：检查是否已有相似记忆
      const similar = await findSimilarMemory(supabase, table, userId, content, projectId)
      if (similar) {
        // 已有相似记忆：不自动写库，反馈给模型让它自行决定合并/更新/跳过
        log.info('memory', `remember 发现相似记忆，反馈模型自行处理`, {
          table,
          projectId: projectId ?? null,
          similarId: similar.id,
          newContentLength: content.length,
          oldContentLength: similar.content.length,
        })
        return { action: 'duplicate', id: similar.id, content: similar.content, ok: true, timestamp: ts }
      }

      const id = crypto.randomUUID()
      const { error } = table === 'project_memories'
        ? await supabase.from('project_memories').insert({
            id, user_id: userId, project_id: projectId as string, content,
          })
        : await supabase.from('memories').insert({ id, user_id: userId, content })
      if (error) log.error('memory', `remember 写入失败 (${table})`, error)
      else log.info('memory', `remember 成功`, { table, projectId: projectId ?? null })
      return { action: 'create', id, content, ok: !error, timestamp: ts }
    }
    if (opName === 'update_memory' || opName === 'update_project_memory') {
      const id = String(params.id ?? '')
      const content = String(params.content ?? '').trim()
      if (!UUID_RE.test(id) || !content || content.length > MAX_MEMORY_CHARS) return { action: 'update', id, content, ok: false }
      const ts = new Date().toISOString()
      let error: unknown
      if (table === 'project_memories') {
        if (!projectId) return { action: 'update', id, content, ok: false }
        ;({ error } = await supabase.from('project_memories').update({ content, updated_at: ts })
          .eq('id', id).eq('user_id', userId).eq('project_id', projectId))
      } else {
        ;({ error } = await supabase.from('memories').update({ content, updated_at: ts })
          .eq('id', id).eq('user_id', userId))
      }
      if (error) log.error('memory', `update 失败 (${table})`, error)
      return { action: 'update', id, content, ok: !error, timestamp: ts }
    }
    if (opName === 'forget' || opName === 'forget_project') {
      const id = String(params.id ?? '')
      if (!UUID_RE.test(id)) return { action: 'delete', id, ok: false }
      let error: unknown
      if (table === 'project_memories') {
        if (!projectId) return { action: 'delete', id, ok: false }
        ;({ error } = await supabase.from('project_memories').delete()
          .eq('id', id).eq('user_id', userId).eq('project_id', projectId))
      } else {
        ;({ error } = await supabase.from('memories').delete().eq('id', id).eq('user_id', userId))
      }
      if (error) log.error('memory', `forget 失败 (${table})`, error)
      return { action: 'delete', id, ok: !error }
    }
  } catch (e) {
    log.error('memory', `${opName} 异常`, e)
  }
  return { action: 'create', ok: false }
}

function memoryTool(name: string, description: string, table: MemoryTable, schema: ToolSchema, isProject: boolean): ToolDef {
  return {
    name,
    description,
    schema,
    enabled: f => f.loggedIn && f.memoryEnabled && (isProject ? !!f.projectId : !f.projectId),
    execute: async (input, ctx): Promise<ToolOutcome> => {
      const r = await runMemoryOp(ctx, name, table, input)
      if (r.action === 'duplicate') {
        return {
          result: `这条内容与已有记忆高度相似（id: ${r.id}，内容: ${r.content}）。请自行判断：如需用新内容替换旧内容或合并两条，调用 ${isProject ? 'update_project_memory' : 'update_memory'}；如新内容只是重复，无需操作。`,
          event: { memory: r },
        }
      }
      return { result: r.ok ? '操作成功' : '操作失败', event: { memory: r } }
    },
  }
}

const memorySchema = { type: 'object' as const, properties: { content: { type: 'string', description: "要记住的内容，用简洁的第三人称陈述，例如'用户是一名前端工程师'" } }, required: ['content'] }
const updateSchema = { type: 'object' as const, properties: { id: { type: 'string', description: '要更新的记忆 id' }, content: { type: 'string', description: '更新后的完整内容' } }, required: ['id', 'content'] }
const forgetSchema = { type: 'object' as const, properties: { id: { type: 'string', description: '要删除的记忆 id' } }, required: ['id'] }

export const memoryTools: ToolDef[] = [
  // 全局记忆工具（仅在主聊天可用）
  memoryTool('remember', '在主聊天中保存一条关于用户的全局长期记忆，仅在主聊天内调用此工具。', 'memories', memorySchema, false),
  memoryTool('update_memory', '在主聊天中修正或补充一条已有的全局记忆，仅在主聊天内调用此工具。', 'memories', updateSchema, false),
  memoryTool('forget', '在主聊天中删除一条过时或错误的全局记忆，仅在主聊天内调用此工具。', 'memories', forgetSchema, false),
  // 项目记忆工具（仅在项目内对话可用）
  memoryTool('remember_project', '在项目内保存一条关于用户的项目级记忆，仅在项目内对话时调用此工具。项目记忆与全局记忆完全独立。', 'project_memories', memorySchema, true),
  memoryTool('update_project_memory', '在项目内修正或补充一条已有的项目级记忆，仅在项目内对话时调用此工具。', 'project_memories', updateSchema, true),
  memoryTool('forget_project', '在项目内删除一条过时或错误的项目级记忆，仅在项目内对话时调用此工具。', 'project_memories', forgetSchema, true),
]
