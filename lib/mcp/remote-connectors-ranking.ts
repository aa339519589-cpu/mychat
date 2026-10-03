import type { RemoteConnector, RemoteConnectorTool } from './remote-connectors-core'

type RankedRemoteTool = {
  connector: RemoteConnector
  tool: RemoteConnectorTool
  score: number
}

const SEARCH_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'can', 'could', 'for', 'from', 'help', 'i', 'in', 'is', 'it',
  'me', 'my', 'of', 'on', 'please', 'the', 'this', 'to', 'use', 'with', 'you', 'your',
  '一下', '一个', '一些', '可以', '帮我', '帮忙', '给我', '请', '看看', '一下子', '里面', '相关',
])

const SEARCH_SYNONYMS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['日历', ['calendar', 'event', 'meeting', 'schedule']],
  ['会议', ['calendar', 'event', 'meeting', 'schedule']],
  ['日程', ['calendar', 'event', 'meeting', 'schedule']],
  ['邮件', ['email', 'mail', 'inbox']],
  ['邮箱', ['email', 'mail', 'inbox']],
  ['消息', ['message', 'slack', 'chat']],
  ['聊天', ['message', 'slack', 'chat']],
  ['文档', ['document', 'file', 'drive']],
  ['文件', ['document', 'file', 'drive']],
  ['联系人', ['contact', 'person', 'people']],
  ['搜索', ['search', 'find', 'lookup']],
  ['查找', ['search', 'find', 'lookup']],
  ['创建', ['create', 'add', 'new']],
  ['发送', ['send', 'post', 'message']],
  ['删除', ['delete', 'remove']],
  ['修改', ['update', 'edit', 'change']],
  ['find', ['search', 'lookup']],
  ['lookup', ['search', 'find']],
  ['look', ['search', 'find']],
  ['create', ['add', 'new']],
  ['update', ['edit', 'change']],
  ['remove', ['delete']],
]

const READ_ACTIONS = new Set(['find', 'get', 'lookup', 'search', 'show', 'list', 'check', 'read'])
const WRITE_ACTIONS = new Set(['add', 'create', 'delete', 'edit', 'insert', 'remove', 'send', 'update', 'write', '创建', '添加', '删除', '修改', '发送'])
const ACTION_WORDS = new Set([...READ_ACTIONS, ...WRITE_ACTIONS, 'new', 'query', 'fetch'])

function normalizedTerm(value: string): string {
  if (value.length > 4 && value.endsWith('ies')) return `${value.slice(0, -3)}y`
  if (value.length > 4 && value.endsWith('s') && !value.endsWith('ss')) return value.slice(0, -1)
  return value
}

function hasWriteAction(tool: RemoteConnectorTool): boolean {
  const text = `${tool.name} ${tool.title ?? ''} ${tool.description ?? ''}`.normalize('NFKC').toLocaleLowerCase()
  return [...WRITE_ACTIONS].some(action => /^[a-z]+$/.test(action)
    ? new RegExp(`\\b${action}\\b`, 'u').test(text)
    : text.includes(action))
}

export function toolVisibleToModel(tool: RemoteConnectorTool): boolean {
  return tool.ui?.visibility === undefined || tool.ui.visibility.includes('model')
}

function searchTerms(value: string): Set<string> {
  const normalized = value.normalize('NFKC').toLocaleLowerCase()
  const terms = new Set<string>()
  const tokens = normalized.match(/[\p{Script=Han}]+|[\p{L}\p{N}][\p{L}\p{N}_-]*/gu) ?? []
  for (const token of tokens) {
    if (/^\p{Script=Han}+$/u.test(token)) {
      if (token.length === 1) terms.add(token)
      for (let index = 0; index < token.length - 1; index++) terms.add(token.slice(index, index + 2))
    } else if (!SEARCH_STOP_WORDS.has(token)) {
      terms.add(normalizedTerm(token))
    }
  }
  for (const [phrase, synonyms] of SEARCH_SYNONYMS) {
    if (normalized.includes(phrase)) {
      for (const synonym of synonyms) terms.add(synonym)
    }
  }
  for (const stopWord of SEARCH_STOP_WORDS) terms.delete(stopWord)
  return terms
}

type RemoteToolScore = { subjectScore: number; toolSubjectMatches: number; actionScore: number }

function scoreToolTerms(
  queryTerms: Set<string>,
  titleTerms: Set<string>,
  descriptionTerms: Set<string>,
  connectorTerms: Set<string>,
): RemoteToolScore {
  let subjectScore = 0
  let toolSubjectMatches = 0
  let actionScore = 0
  for (const term of queryTerms) {
    const inTitle = titleTerms.has(term)
    const inDescription = descriptionTerms.has(term)
    if (ACTION_WORDS.has(term)) {
      actionScore += inTitle ? 2 : inDescription ? 1 : 0
      continue
    }
    if (inTitle) { subjectScore += 4; toolSubjectMatches++ }
    if (inDescription) { subjectScore += 3; toolSubjectMatches++ }
    if (connectorTerms.has(term)) subjectScore++
  }
  return { subjectScore, toolSubjectMatches, actionScore }
}

function requestIntent(queryTerms: Set<string>, query: string): { read: boolean; write: boolean } {
  return {
    read: [...queryTerms].some(term => READ_ACTIONS.has(term)) || /[查找搜索看询]/u.test(query),
    write: [...queryTerms].some(term => WRITE_ACTIONS.has(term)) || /[创建添加删除修改发送]/u.test(query),
  }
}

function scoreRemoteTool(input: {
  connector: RemoteConnector
  tool: RemoteConnectorTool
  queryTerms: Set<string>
  semanticTerms: string[]
  connectorTerms: Set<string>
  intent: { read: boolean; write: boolean }
}): RankedRemoteTool | null {
  const { connector, tool, queryTerms, semanticTerms, connectorTerms, intent } = input
  if (!toolVisibleToModel(tool)) return null
  const titleTerms = searchTerms(`${tool.title ?? ''} ${tool.name}`)
  const descriptionTerms = searchTerms(tool.description ?? '')
  const scores = scoreToolTerms(queryTerms, titleTerms, descriptionTerms, connectorTerms)
  if (semanticTerms.length > 0 && scores.toolSubjectMatches === 0) return null
  const writes = hasWriteAction(tool)
  if (intent.read && !intent.write && writes) return null
  if (intent.write && !intent.read && !writes) return null
  const score = scores.subjectScore * 5 + scores.actionScore
  return score > 0 ? { connector, tool, score } : null
}

export function rankedRemoteTools(connectors: RemoteConnector[], query: string): RankedRemoteTool[] {
  const queryTerms = searchTerms(query)
  if (!queryTerms.size) return []
  const semanticTerms = [...queryTerms].filter(term => !ACTION_WORDS.has(term) && term.length > 1)
  const intent = requestIntent(queryTerms, query)
  const ranked: RankedRemoteTool[] = []
  for (const connector of connectors) {
    const connectorTerms = searchTerms(connector.name)
    for (const tool of connector.tools) {
      const scored = scoreRemoteTool({ connector, tool, queryTerms, semanticTerms, connectorTerms, intent })
      if (scored) ranked.push(scored)
    }
  }
  return ranked.sort((lhs, rhs) => rhs.score - lhs.score
    || lhs.connector.name.localeCompare(rhs.connector.name)
    || (lhs.tool.title ?? lhs.tool.name).localeCompare(rhs.tool.title ?? rhs.tool.name))
}
