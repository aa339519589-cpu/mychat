const COMPOSER_SELECTORS = [
  '#prompt-textarea',
  '[data-testid="prompt-textarea"]',
  'textarea[placeholder]',
  'main [contenteditable="true"]',
]

const SEND_SELECTORS = [
  'button[data-testid="send-button"]',
  'button[aria-label="Send prompt"]',
  'button[aria-label="Send message"]',
  'button[aria-label*="发送"]',
  'form button[type="submit"]',
]

const STOP_SELECTORS = [
  'button[data-testid="stop-button"]',
  'button[aria-label="Stop generating"]',
  'button[aria-label*="Stop"]',
  'button[aria-label*="停止"]',
]

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function visible(element) {
  if (!(element instanceof Element)) return false
  const rect = element.getBoundingClientRect()
  const style = window.getComputedStyle(element)
  return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
}

function firstVisible(selectors) {
  for (const selector of selectors) {
    for (const element of document.querySelectorAll(selector)) {
      if (visible(element)) return element
    }
  }
  return null
}

async function waitForComposer(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const composer = firstVisible(COMPOSER_SELECTORS)
    if (composer) return composer
    await sleep(500)
  }
  throw new Error('没有找到 ChatGPT 输入框；请确认 chatgpt.com 已登录并能正常聊天')
}

function replaceEditable(element, text) {
  element.focus()
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
    if (setter) setter.call(element, text)
    else element.value = text
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }))
    element.dispatchEvent(new Event('change', { bubbles: true }))
    return
  }

  if (element instanceof HTMLElement && element.isContentEditable) {
    const selection = window.getSelection()
    if (selection) {
      const range = document.createRange()
      range.selectNodeContents(element)
      selection.removeAllRanges()
      selection.addRange(range)
    }
    let inserted = false
    try { inserted = document.execCommand('insertText', false, text) } catch { inserted = false }
    if (!inserted || !element.innerText.trim()) {
      const fragment = document.createDocumentFragment()
      const lines = text.split('\n')
      for (const line of lines) {
        const paragraph = document.createElement('p')
        if (line) paragraph.textContent = line
        else paragraph.append(document.createElement('br'))
        fragment.append(paragraph)
      }
      element.replaceChildren(fragment)
      element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }))
    }
    element.dispatchEvent(new Event('change', { bubbles: true }))
    return
  }
  throw new Error('ChatGPT 输入框类型无法识别')
}

function assistantNodes() {
  const direct = [...document.querySelectorAll('[data-message-author-role="assistant"]')]
    .filter(visible)
  if (direct.length) return direct
  return [...document.querySelectorAll('main article[data-testid^="conversation-turn-"]')]
    .filter(element => visible(element) && element.innerText.trim())
}

function assistantText(element) {
  if (!(element instanceof HTMLElement)) return ''
  const markdown = element.querySelector('.markdown, [class*="markdown"]')
  const text = markdown instanceof HTMLElement ? markdown.innerText : element.innerText
  return (text ?? '').trim()
}

function generating() {
  return STOP_SELECTORS.some(selector => [...document.querySelectorAll(selector)].some(visible))
}

async function waitForSend(timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const button = firstVisible(SEND_SELECTORS)
    if (button instanceof HTMLButtonElement && !button.disabled) return button
    await sleep(200)
  }
  throw new Error('ChatGPT 发送按钮不可用')
}

function composePrompt(input) {
  const messages = Array.isArray(input?.messages) ? input.messages : []
  const sections = [
    '这是 MyChat Long Think 的一轮连续推断。下面的 SYSTEM / USER / ASSISTANT 标签表示这一轮要继承的消息角色。严格执行其中要求，并只返回这一轮要求的结果。',
  ]
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue
    const role = typeof message.role === 'string' ? message.role.toUpperCase() : 'USER'
    const content = typeof message.content === 'string' ? message.content : ''
    sections.push(`\n<<<${role}>>>\n${content}`)
  }
  if (Number.isSafeInteger(input?.maxTokens) && input.maxTokens > 0) {
    sections.push(`\n单轮目标输出预算：最多 ${input.maxTokens} token；不需要为了填满预算而增加废话。`)
  }
  return sections.join('\n')
}

async function waitForAnswer(beforeCount, timeoutMs = 25 * 60 * 1000) {
  const deadline = Date.now() + timeoutMs
  let lastText = ''
  let stableSince = 0
  while (Date.now() < deadline) {
    const nodes = assistantNodes()
    const candidate = nodes.length > beforeCount ? nodes[nodes.length - 1] : null
    const text = candidate ? assistantText(candidate) : ''
    if (text && text === lastText) {
      if (!stableSince) stableSince = Date.now()
    } else {
      lastText = text
      stableSince = text ? Date.now() : 0
    }
    if (text && !generating() && stableSince && Date.now() - stableSince >= 3_500) {
      return text
    }
    await sleep(400)
  }
  throw new Error('等待 ChatGPT 完成本轮超时')
}

async function runTurn(input) {
  const composer = await waitForComposer()
  const beforeCount = assistantNodes().length
  const prompt = composePrompt(input)
  replaceEditable(composer, prompt)
  await sleep(250)
  const send = await waitForSend()
  send.click()
  const text = await waitForAnswer(beforeCount)
  return { text, reasoning: '', finishReason: 'stop' }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== 'mychat-run-turn') return false
  void runTurn(message.input)
    .then(result => sendResponse({ ok: true, ...result }))
    .catch(error => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }))
  return true
})
