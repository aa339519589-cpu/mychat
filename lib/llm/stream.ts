// 服务器端 SSE 收发 + 上游错误格式化

const enc = new TextEncoder()

// 往 SSE 流写一个 data 事件
export function send(controller: ReadableStreamDefaultController, data: object) {
  controller.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`))
}

// 结束 SSE 流
export function done(controller: ReadableStreamDefaultController) {
  controller.enqueue(enc.encode('data: [DONE]\n\n'))
  controller.close()
}

function readErrorMessage(raw: string) {
  try {
    const parsed = JSON.parse(raw)
    return parsed?.error?.message ?? parsed?.message ?? raw
  } catch {
    return raw
  }
}

// 把上游模型服务返回的错误整理成给用户看的中文说明
export function upstreamError(status: number, raw: string, source = '模型服务') {
  const message = String(readErrorMessage(raw)).replace(/\s+/g, ' ').trim()
  const modelMismatch = message.match(/supported API model names are (.+?),?\s+but you passed\s+(.+?)(?:[."']|$)/i)

  if (modelMismatch) {
    const supported = modelMismatch[1].replace(/\s+or\s+/gi, ' 或 ')
    const current = modelMismatch[2].trim()
    return `模型名不匹配。该服务支持 ${supported}；当前填写的是 ${current}。请在设置的高级配置里修改模型名。`
  }
  if (status === 401 || status === 403) return `${source}拒绝了 API Key，请检查 Key 或权限。`
  if (status === 429) return `${source}请求过于频繁，或账户余额不足。`

  return `${source}请求失败（${status}）：${message.slice(0, 180) || '未返回原因'}`
}

// 把网络层异常整理成给用户看的中文说明
export function networkError(error: unknown, source = '模型服务') {
  const message = error instanceof Error ? error.message : String(error)
  if (message === 'fetch failed') return `无法连接${source}，请检查服务地址。`
  return `${source}请求失败：${message}`
}
