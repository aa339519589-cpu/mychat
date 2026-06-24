// 工具调用协议标记过滤。某些模型（尤其 DeepSeek 的 DSML）会把工具调用标记当成
// 正文 token 吐进 content 通道，绝不能流到前端。两种用法：
//   - makeContentFilter(): 流式安全，逐 chunk feed，跨 chunk 边界也能正确剥离。
//   - stripToolMarkup():   一次性整段清洗，供前端兜底。

// 成对包裹：从开标记到闭标记之间整段视作工具协议丢弃；未闭合则丢到流末。
const PAIR_RULES: { open: string; close: string }[] = [
  { open: "<｜tool▁calls▁begin｜>", close: "<｜tool▁calls▁end｜>" },
  { open: "<|tool_calls_begin|>", close: "<|tool_calls_end|>" },
  { open: "<｜DSML｜tool_calls>", close: "</｜DSML｜tool_calls>" }, // deepseek-v4-pro 文本式工具调用，整段丢弃
  { open: "<｜DSML｜invoke", close: "</｜DSML｜invoke>" },          // 同上，缺外层包裹时兜底
  { open: "<function_calls>", close: "</function_calls>" },
  { open: "<invoke", close: "</invoke>" },
]

// 零散标记：直接抹掉。注意——这些都不是上面的成对开/闭标记，避免吃掉成对开标记后漏出内层正文。
const STANDALONE_RES: RegExp[] = [
  /<｜tool▁sep｜>/g,
  /<｜\/?tool[^｜]*｜>/g, // 其它 <｜tool…｜> 单标记（不含 begin/end，已被成对规则处理）
  /<\|tool▁sep\|>/g,
  /<\/?｜DSML｜[^>]*>/g,     // 全角 <｜DSML｜…> / </｜DSML｜…>（deepseek-v4-pro）
  /<\|\|?\s*DSML[^>]*>/gi,  // 半角 <|| DSML ...>
  /<\/?\s*[｜|]\s*DSML\s*[｜|][^>]*>/gi, // DSML 标记宽松兜底（全/半角竖线混用）
  /<\/?parameter\b[^>]*>/gi,
]

// 仅一次性清洗时额外清除可能残留的孤立工具标签（流式里这些由成对规则负责，不在此列以免漏出内层）。
const ORPHAN_RES: RegExp[] = [
  /<\/?(?:invoke|function_calls|tool_call|tool_calls)\b[^>]*>/gi,
  /<｜tool▁calls?▁(?:begin|end)｜>/g,
  /<\|tool_calls?_(?:begin|end)\|>/g,
  /<\/?\s*[｜|]?\s*DSML\s*[｜|]?[^>]*>/gi, // DSML 残留标签兜底
]

// 最长可能被截断的标记长度（流式时保留这么多尾巴，防半个标记被放行）。
const MAX_MARKER = 32

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function stripStandalone(s: string): string {
  let r = s
  for (const re of STANDALONE_RES) r = r.replace(re, "")
  return r
}

// 一次性整段清洗（前端兜底用）。
export function stripToolMarkup(text: string): string {
  if (!text) return text
  let s = text
  for (const { open, close } of PAIR_RULES) {
    const o = escapeRegExp(open)
    const c = escapeRegExp(close)
    s = s.replace(new RegExp(o + "[\\s\\S]*?" + c, "g"), "") // 闭合的成对块
    s = s.replace(new RegExp(o + "[\\s\\S]*$"), "") // 未闭合：删到结尾
  }
  s = stripStandalone(s)
  for (const re of ORPHAN_RES) s = s.replace(re, "")
  return s
}

// 流式安全过滤器：成对开标记先在原始 buf 上用 indexOf 定位（绝不被零散正则吃掉），
// 零散标记只作用于"即将放出的安全文本"。
export function makeContentFilter() {
  let buf = ""
  let waitingClose: string | null = null

  function feed(chunk: string): string {
    buf += chunk
    let out = ""
    for (;;) {
      if (waitingClose) {
        const ci = buf.indexOf(waitingClose)
        if (ci === -1) {
          // 闭标记还没到：抑制区内容全部丢弃，只留可能是闭标记前缀的尾巴
          if (buf.length > MAX_MARKER) buf = buf.slice(buf.length - MAX_MARKER)
          break
        }
        buf = buf.slice(ci + waitingClose.length)
        waitingClose = null
        continue
      }
      // 找最早出现的成对开标记
      let bestIdx = -1
      let bestRule: { open: string; close: string } | null = null
      for (const rule of PAIR_RULES) {
        const i = buf.indexOf(rule.open)
        if (i !== -1 && (bestIdx === -1 || i < bestIdx)) {
          bestIdx = i
          bestRule = rule
        }
      }
      if (bestIdx === -1) {
        // 没有完整开标记：放出除尾部 MAX_MARKER 外的安全文本（尾部可能是半个标记）
        const safeLen = buf.length - MAX_MARKER
        if (safeLen > 0) {
          out += stripStandalone(buf.slice(0, safeLen))
          buf = buf.slice(safeLen)
        }
        break
      }
      out += stripStandalone(buf.slice(0, bestIdx))
      buf = buf.slice(bestIdx + bestRule!.open.length)
      waitingClose = bestRule!.close
    }
    return out
  }

  function flush(): string {
    if (waitingClose) {
      buf = ""
      waitingClose = null
      return "" // 未闭合的工具区整体丢弃
    }
    const out = stripStandalone(buf)
    buf = ""
    return out
  }

  return { feed, flush }
}

// 解析 deepseek-v4-pro 用 DSML 文本写出的工具调用（而非标准 tool_calls 字段），
// 转成标准 {id,name,args}，让 route 的多轮循环能照常执行工具、模型不至于中断。
// 格式示例：<｜DSML｜invoke name="web_search"><｜DSML｜parameter name="query" ...>关键词</｜DSML｜parameter></｜DSML｜invoke>
export function parseDsmlToolCalls(raw: string): { id: string; name: string; args: string }[] {
  if (!raw || !/DSML/i.test(raw)) return []
  const calls: { id: string; name: string; args: string }[] = []

  // 多模式匹配，覆盖不同全/半角竖线组合、空格变化
  const invokeRes = [
    // 标准全角 DSML：<｜DSML｜invoke name="...">...</｜DSML｜invoke>
    /<[｜|]+\s*DSML\s*[｜|]*\s*invoke\s+name\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/[｜|]+\s*DSML\s*[｜|]*\s*invoke\s*>/gi,
    // 半角竖线：<||DSML||invoke name="...">...</||DSML||invoke>
    /<\|\|?\s*DSML\s*\|?\|\s*invoke\s+name\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/\|?\|\s*DSML\s*\|?\|\s*invoke\s*>/gi,
    // 宽松兜底：< 任意 DSML invoke
    /<[^>]*DSML[^>]*invoke\s+name\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/[^>]*DSML[^>]*invoke\s*>/gi,
  ]

  for (const invokeRe of invokeRes) {
    let m: RegExpExecArray | null
    while ((m = invokeRe.exec(raw)) !== null) {
      const name = m[1].trim()
      const inner = m[2]
      // 去重（同一 name + args 组合只取一次）
      const args: Record<string, string> = {}
      const paramRes = [
        /<[｜|]+\s*DSML\s*[｜|]*\s*parameter\s+name\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/[｜|]+\s*DSML\s*[｜|]*\s*parameter\s*>/gi,
        /<\|\|?\s*DSML\s*\|?\|\s*parameter\s+name\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/\|?\|\s*DSML\s*\|?\|\s*parameter\s*>/gi,
        /<[^>]*DSML[^>]*parameter\s+name\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/[^>]*DSML[^>]*parameter\s*>/gi,
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
  return calls
}

// 检测 rawContent 末尾是否存在未闭合的 DSML 工具调用（流被截断导致）。
// 用于 agent-loop 判断是否需要 auto-continue 来获取完整的工具调用闭合标签。
export function hasIncompleteDsmlToolCall(raw: string): boolean {
  if (!raw || !/DSML/i.test(raw)) return false
  // 找到最后一个 DSML invoke 的开标记
  const openRe = /<[｜|]+\s*DSML\s*[｜|]*\s*invoke\s+name\s*=\s*"[^"]+"[^>]*>/gi
  let lastOpen = -1
  let m: RegExpExecArray | null
  while ((m = openRe.exec(raw)) !== null) lastOpen = m.index
  if (lastOpen === -1) return false
  // 查这个开标记后面有没有对应的闭合
  const after = raw.slice(lastOpen)
  const closeRe = /<\/[｜|]+\s*DSML\s*[｜|]*\s*invoke\s*>/gi
  return !closeRe.test(after)
}
