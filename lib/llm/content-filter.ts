// 工具调用协议标记过滤。某些模型（尤其 DeepSeek 的 DSML）会把工具调用标记当成
// 正文 token 吐进 content 通道，绝不能流到前端。流式与一次性清洗共享同一套规则。

const PAIR_RULES: { open: string; close: string }[] = [
  { open: "<｜tool▁calls▁begin｜>", close: "<｜tool▁calls▁end｜>" },
  { open: "<|tool_calls_begin|>", close: "<|tool_calls_end|>" },
  { open: "<｜DSML｜tool_calls>", close: "</｜DSML｜tool_calls>" },
  { open: "<｜DSML｜invoke", close: "</｜DSML｜invoke>" },
  { open: "<function_calls>", close: "</function_calls>" },
  { open: "<invoke", close: "</invoke>" },
]

const STANDALONE_RES: RegExp[] = [
  /<｜tool▁sep｜>/g,
  /<｜\/?tool[^｜]*｜>/g,
  /<\|tool▁sep\|>/g,
  /<\/?｜DSML｜[^>]*>/g,
  /<\|\|?\s*DSML[^>]*>/gi,
  /<\/?\s*[｜|]\s*DSML\s*[｜|][^>]*>/gi,
  /<\/?parameter\b[^>]*>/gi,
]

const ORPHAN_RES: RegExp[] = [
  /<\/?(?:invoke|function_calls|tool_call|tool_calls)\b[^>]*>/gi,
  /<｜tool▁calls?▁(?:begin|end)｜>/g,
  /<\|tool_calls?_(?:begin|end)\|>/g,
  /<\/?\s*[｜|]?\s*DSML\s*[｜|]?[^>]*>/gi,
]

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
    s = s.replace(new RegExp(o + "[\\s\\S]*?" + c, "g"), "")
    s = s.replace(new RegExp(o + "[\\s\\S]*$"), "")
  }
  s = stripStandalone(s)
  for (const re of ORPHAN_RES) s = s.replace(re, "")
  return s
}

// 流式安全过滤器：成对开标记先在原始 buf 上用 indexOf 定位，零散标记只作用于即将放出的安全文本。
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
          if (buf.length > MAX_MARKER) buf = buf.slice(buf.length - MAX_MARKER)
          break
        }
        buf = buf.slice(ci + waitingClose.length)
        waitingClose = null
        continue
      }
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
      // 开标记之后的内容全部属于未闭合工具协议。不能把末尾参数“抢救”为正文，
      // 否则截断的 JSON、文件内容或密钥会泄漏到前端。
      buf = ""
      waitingClose = null
      return ""
    }
    const out = stripStandalone(buf)
    buf = ""
    return out
  }

  return { feed, flush }
}
