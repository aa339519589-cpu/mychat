const urlInput = document.querySelector('#url')
const tokenInput = document.querySelector('#token')
const saveButton = document.querySelector('#save')
const status = document.querySelector('#status')

function normalizeUrl(value) {
  const url = new URL(value.trim())
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    throw new Error('MyChat 地址必须使用 HTTPS')
  }
  return url.origin
}

async function load() {
  const stored = await chrome.storage.local.get(['myChatUrl', 'pairToken'])
  urlInput.value = typeof stored.myChatUrl === 'string' ? stored.myChatUrl : ''
  tokenInput.value = typeof stored.pairToken === 'string' ? stored.pairToken : ''
}

async function save() {
  status.textContent = ''
  try {
    const myChatUrl = normalizeUrl(urlInput.value)
    const pairToken = tokenInput.value.trim()
    if (!pairToken) throw new Error('请粘贴 MyChat 配对令牌')
    await chrome.storage.local.set({ myChatUrl, pairToken })
    chrome.runtime.sendMessage({ type: 'bridge-config-updated' })
    status.textContent = '已保存，桥接循环已启动。'
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error)
  }
}

saveButton.addEventListener('click', () => { void save() })
void load()
