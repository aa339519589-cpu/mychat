// 记忆工具：两套独立系统
// ① 全局记忆（主聊天）：remember / update_memory / forget → 写 memories 表
// ② 项目记忆（项目内）：remember_project / update_project_memory / forget_project → 写 project_memories 表
import type { ToolDef, ToolOutcome, ToolSchema } from './types'
import { runMemoryOperation } from './memory-operations'

type MemoryTable = 'memories' | 'project_memories'

function memoryTool(
  name: string,
  description: string,
  table: MemoryTable,
  schema: ToolSchema,
  isProject: boolean,
): ToolDef {
  return {
    name,
    description,
    schema,
    enabled: f => f.loggedIn && f.memoryEnabled && (isProject ? !!f.projectId : !f.projectId),
    execute: async (input, ctx): Promise<ToolOutcome> => {
      const r = await runMemoryOperation(ctx, name, table, input)
      if (r.reason === 'sensitive_consent_required') {
        return {
          result: '没有保存：这段内容属于敏感记忆。只有用户在 Memory 设置中明确开启敏感记忆保存后才能保存。',
          event: { memory: r },
        }
      }
      if (r.reason === 'prohibited_content') {
        return {
          result: '没有保存：MyChat 不会记忆政府证件号码、犯罪记录、账户号码或移民身份等信息。',
          event: { memory: r },
        }
      }
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

const memorySchema = { type: 'object' as const, properties: {
  content: { type: 'string', description: "要记住的内容，用简洁的第三人称陈述，例如'用户是一名前端工程师'" },
  topic: { type: 'string', description: '稳定且简短的主题名称；沿用已有相似主题，例如“偏好”“工作”“长期目标”“项目”' },
}, required: ['content'] }
const updateSchema = { type: 'object' as const, properties: {
  id: { type: 'string', description: '要更新的记忆 id' },
  content: { type: 'string', description: '更新后的完整内容' },
  topic: { type: 'string', description: '更新后的主题；若不需要调整主题可省略' },
}, required: ['id', 'content'] }
const forgetSchema = { type: 'object' as const, properties: { id: { type: 'string', description: '要删除的记忆 id' } }, required: ['id'] }

export const memoryTools: ToolDef[] = [
  // 全局记忆工具（仅在主聊天可用）
  memoryTool('remember', '在主聊天中保存一条关于用户的全局长期记忆。为记忆分配可复用的简短主题；仅在主聊天内调用。', 'memories', memorySchema, false),
  memoryTool('update_memory', '在主聊天中修正或合并一条已有的全局记忆；保留其主题，除非主题需要更正。仅在主聊天内调用。', 'memories', updateSchema, false),
  memoryTool('forget', '在主聊天中删除一条过时或错误的全局记忆，仅在主聊天内调用此工具。', 'memories', forgetSchema, false),
  // 项目记忆工具（仅在项目内对话可用）
  memoryTool('remember_project', '在项目内保存一条关于当前项目的长期记忆并分配可复用的简短主题。项目记忆与全局记忆完全独立。', 'project_memories', memorySchema, true),
  memoryTool('update_project_memory', '在当前项目内修正或合并一条已有记忆；保留其主题，除非需要更正。', 'project_memories', updateSchema, true),
  memoryTool('forget_project', '在项目内删除一条过时或错误的项目级记忆，仅在项目内对话时调用此工具。', 'project_memories', forgetSchema, true),
]
