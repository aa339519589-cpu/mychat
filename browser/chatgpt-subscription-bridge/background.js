const ALARM = 'mychat-chatgpt-bridge'
let loopRunning = false

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function normalizeBaseUrl(value) {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) return ''
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') return ''
    return url.origin
  } catch { return '' }
}

async function config() {
  const stored = await chrome.storage.local.get(['myChatUrl', 'pairToken', 'clientId'])
  let clientId = typeof stored.clientId === 'string' ? stored.clientId : ''
  if (!clientId) {
    clientId = crypto.randomUUID()
    await chrome.storage.local.set({ clientId })
  }
  return {
    myChatUrl: normalizeBaseUrl(stored.myChatUrl),
    pairToken: typeof stored.pairToken === 'string' ? stored.pairToken.trim() : '',
    clientId,
  }
}

async function bridgeFetch(baseUrl, pairToken, path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      ...(init.headers || {}),
      authorization: `Bearer ${pairToken}`,
    },
    cache: 'no-store',
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    const detail = body?.error?.message || body?.message || `HTTP ${response.status}`
    const error = new Error(detail)
    error.status = response.status
    throw error
  }
  return body
}

async function claimNext(cfg) {
  const body = await bridgeFetch(cfg.myChatUrl, cfg.pairToken, '/api/chatgpt-bridge/next', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clientId: cfg.clientId }),
  })
  return body?.job || null
}

function waitForTab(tabId, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    let timer
    const cleanup = () => {
      chrome.tabs.onUpdated.removeListener(updated)
      if (timer) clearTimeout(timer)
    }
    const updated = (id, info) => {
      if (id !== tabId || info.status !== 'complete') return
      cleanup(); resolve()
    }
    chrome.tabs.onUpdated.addListener(updated)
    timer = setTimeout(() => { cleanup(); reject(new Error('打开 chatgpt.com 超时')) }, timeoutMs)
    chrome.tabs.get(tabId).then(tab => {
      if (tab.status === 'complete') { cleanup(); resolve() }
    }).catch(() => undefined)
  })
}

async function sendTurn(tabId, input) {
  const deadline = Date.now() + 30_000
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, { type: 'mychat-run-turn', input })
      if (response) return response
    } catch (error) { lastError = error }
    await sleep(500)
  }
  throw lastError || new Error('ChatGPT 网页桥没有响应')
}

async function heartbeat(cfg, claimToken, signal) {
  while (!signal.aborted) {
    await sleep(60_000)
    if (signal.aborted) return
    try {
      const body = await bridgeFetch(cfg.myChatUrl, cfg.pairToken, '/api/chatgpt-bridge/heartbeat', {
        method: 'POST',
        headers: { 'x-chatgpt-claim': claimToken },
      })
      if (body?.cancelRequested) return
    } catch { return }
  }
}

async function complete(cfg, claimToken, result) {
  return bridgeFetch(cfg.myChatUrl, cfg.pairToken, '/api/chatgpt-bridge/complete', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-chatgpt-claim': claimToken,
    },
    body: JSON.stringify(result),
  })
}

async function processJob(cfg, job) {
  if (!job || typeof job.claimToken !== 'string') return
  const heartbeatAbort = new AbortController()
  void heartbeat(cfg, job.claimToken, heartbeatAbort.signal)
  let tabId = null
  try {
    const tab = await chrome.tabs.create({ url: 'https://chatgpt.com/', active: false })
    if (!tab.id) throw new Error('无法创建 ChatGPT 标签页')
    tabId = tab.id
    await waitForTab(tabId)
    const response = await sendTurn(tabId, job.input)
    if (!response?.ok) {
      await complete(cfg, job.claimToken, { ok: false, error: response?.error || 'ChatGPT 网页执行失败' })
      return
    }
    await complete(cfg, job.claimToken, {
      ok: true,
      text: typeof response.text === 'string' ? response.text : '',
      reasoning: typeof response.reasoning === 'string' ? response.reasoning : '',
      finishReason: typeof response.finishReason === 'string' ? response.finishReason : 'stop',
    })
  } catch (error) {
    try {
      await complete(cfg, job.claimToken, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    } catch { /* lease may already be gone */ }
  } finally {
    heartbeatAbort.abort()
    if (tabId !== null) await chrome.tabs.remove(tabId).catch(() => undefined)
  }
}

async function pollLoop() {
  if (loopRunning) return
  loopRunning = true
  try {
    while (true) {
      const cfg = await config()
      if (!cfg.myChatUrl || !cfg.pairToken) return
      try {
        const job = await claimNext(cfg)
        if (job) {
          await processJob(cfg, job)
          continue
        }
      } catch (error) {
        if (error?.status === 401) return
      }
      await sleep(1_500)
    }
  } finally { loopRunning = false }
}

async function arm() {
  await chrome.alarms.clear(ALARM).catch(() => undefined)
  chrome.alarms.create(ALARM, { delayInMinutes: 0.1, periodInMinutes: 0.5 })
  void pollLoop()
}

chrome.runtime.onInstalled.addListener(() => { void arm() })
chrome.runtime.onStartup.addListener(() => { void arm() })
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === ALARM) void pollLoop() })
chrome.action.onClicked.addListener(() => { void chrome.runtime.openOptionsPage() })
chrome.runtime.onMessage.addListener(message => {
  if (message?.type === 'bridge-config-updated') void arm()
})

void arm()
