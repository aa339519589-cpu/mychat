// DeepSeek 的 DSML 文本式工具调用解析与截断判断。

// 将 deepseek-v4-pro 文本式工具调用解析成标准 {id,name,args}。
export function parseDsmlToolCalls(raw: string): { id: string; name: string; args: string }[] {
  if (!raw || !/DSML/i.test(raw)) return []
  const calls: { id: string; name: string; args: string }[] = []

  const invokeRes = [
    /<[｜|]+\s*DSML\s*[｜|]*\s*invoke\s+name\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/[｜|]+\s*DSML\s*[｜|]*\s*invoke\s*>/gi,
    /<\|\|?\s*DSML\s*\|?\|\s*invoke\s+name\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/\|?\|\s*DSML\s*\|?\|\s*invoke\s*>/gi,
    /<[^>]*DSML[^>]*invoke\s+name\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/[^>]*DSML[^>]*invoke\s*>/gi,
    /<[｜|]+\s*DSML\s*[｜|]*\s*invoke\s+name\s*=\s*'([^']+)'[^>]*>([\s\S]*?)<\/[｜|]+\s*DSML\s*[｜|]*\s*invoke\s*>/gi,
    /<[｜|]+\s*DSML\s*[｜|]*\s*invoke\s+name\s*=\s*(\S+?)(?:\s+[^>]*)?>([\s\S]*?)<\/[｜|]+\s*DSML\s*[｜|]*\s*invoke\s*>/gi,
  ]

  for (const invokeRe of invokeRes) {
    let m: RegExpExecArray | null
    while ((m = invokeRe.exec(raw)) !== null) {
      const name = m[1].trim()
      const inner = m[2]
      const args: Record<string, string> = {}
      const paramRes = [
        /<[｜|]+\s*DSML\s*[｜|]*\s*parameter\s+name\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/[｜|]+\s*DSML\s*[｜|]*\s*parameter\s*>/gi,
        /<\|\|?\s*DSML\s*\|?\|\s*parameter\s+name\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/\|?\|\s*DSML\s*\|?\|\s*parameter\s*>/gi,
        /<[^>]*DSML[^>]*parameter\s+name\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/[^>]*DSML[^>]*parameter\s*>/gi,
        /<[｜|]+\s*DSML\s*[｜|]*\s*parameter\s+name\s*=\s*'([^']+)'[^>]*>([\s\S]*?)<\/[｜|]+\s*DSML\s*[｜|]*\s*parameter\s*>/gi,
        /<[｜|]+\s*DSML\s*[｜|]*\s*parameter\s+name\s*=\s*(\S+?)(?:\s+string\s*=\s*"(?:true|false)")?[^>]*>([\s\S]*?)<\/[｜|]+\s*DSML\s*[｜|]*\s*parameter\s*>/gi,
      ]
      for (const paramRe of paramRes) {
        let pm: RegExpExecArray | null
        while ((pm = paramRe.exec(inner)) !== null) args[pm[1].trim()] = pm[2].trim()
      }
      const key = `${name}:${JSON.stringify(args)}`
      if (name && !calls.some(c => `${c.name}:${c.args}` === key)) {
        calls.push({ id: `dsml_${calls.length}_${Math.random().toString(36).slice(2, 8)}`, name, args: JSON.stringify(args) })
      }
    }
  }

  if (calls.length === 0) {
    const knownTools = ['list_files', 'read_file', 'create_repo', 'write_files', 'edit_file',
      'delete_files', 'execute', 'enable_pages', 'code_remember', 'search',
      'web_search', 'remember', 'forget', 'update_memory']
    const toolNames = knownTools.join('|')
    const bareXmlRe = new RegExp(
      `<(${toolNames})((?:\\s+[a-zA-Z_][a-zA-Z0-9_]*\\s*=\\s*"(?:[^"\\\\]|\\\\.)*")*)\\s*(?:>([\\s\\S]*?)<\\/\\1>|\\/?>)`,
      'gi'
    )
    let bm: RegExpExecArray | null
    while ((bm = bareXmlRe.exec(raw)) !== null) {
      const name = bm[1].trim()
      const attrs = bm[2] || ''
      const args: Record<string, string> = {}
      const attrRe = /([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*"((?:[^"\\]|\\.)*)"/g
      let am: RegExpExecArray | null
      while ((am = attrRe.exec(attrs)) !== null) args[am[1].trim()] = am[2].replace(/\\"/g, '"')
      const inner = bm[3]?.trim()
      if (inner) args._content = inner
      const key = `${name}:${JSON.stringify(args)}`
      if (name && !calls.some(c => `${c.name}:${c.args}` === key)) {
        calls.push({ id: `xml_${calls.length}_${Math.random().toString(36).slice(2, 8)}`, name, args: JSON.stringify(args) })
      }
    }
  }

  return calls
}

// 检测 rawContent 末尾是否存在未闭合的 DSML 工具调用（流被截断导致）。
export function hasIncompleteDsmlToolCall(raw: string): boolean {
  if (!raw || !/DSML/i.test(raw)) return false
  const openRes = [
    /<[｜|]+\s*DSML\s*[｜|]*\s*invoke\s+name\s*=\s*"[^"]*"[^>]*>/gi,
    /<[｜|]+\s*DSML\s*[｜|]*\s*invoke\s+name\s*=\s*'[^']*'[^>]*>/gi,
    /<[｜|]+\s*DSML\s*[｜|]*\s*invoke\s+name\s*=\s*\S+[^>]*>/gi,
    /<[^>]*DSML[^>]*invoke\s+name\s*=\s*"[^"]*"[^>]*>/gi,
  ]
  let lastOpen = -1
  for (const openRe of openRes) {
    let m: RegExpExecArray | null
    while ((m = openRe.exec(raw)) !== null) {
      if (m.index > lastOpen) lastOpen = m.index
    }
  }
  if (lastOpen === -1) return false
  const after = raw.slice(lastOpen)
  const closeRes = [
    /<\/[｜|]+\s*DSML\s*[｜|]*\s*invoke\s*>/gi,
    /<\/[^>]*DSML[^>]*invoke\s*>/gi,
  ]
  return !closeRes.some(re => re.test(after))
}
