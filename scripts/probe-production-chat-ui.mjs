import { randomBytes } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { chromium, devices } from '@playwright/test'

const productionUrl = process.env.PRODUCTION_URL
const renderApiKey = process.env.RENDER_API_KEY
const renderServiceId = process.env.RENDER_SERVICE_ID
const resultPath = process.env.STREAM_UI_PROBE_RESULT_PATH || '/tmp/chat-stream-ui-probe.json'

async function json(response, label) {
  const text = await response.text()
  let body = null
  try { body = text ? JSON.parse(text) : null } catch {}
  if (!response.ok) throw new Error(`${label} failed (${response.status}): ${text.slice(0, 500)}`)
  return body
}

async function renderEnv(key) {
  const response = await fetch(`https://api.render.com/v1/services/${renderServiceId}/env-vars/${key}`, {
    headers: { Authorization: `Bearer ${renderApiKey}` },
  })
  const body = await json(response, `Read Render ${key}`)
  if (!body || typeof body.value !== 'string' || !body.value) {
    throw new Error(`${key} is unavailable in Render`)
  }
  return body.value
}

async function deleteUser(supabaseUrl, serviceRole, userId) {
  if (!userId) return
  await fetch(`${supabaseUrl}/auth/v1/admin/users/${userId}`, {
    method: 'DELETE',
    headers: { apikey: serviceRole, Authorization: `Bearer ${serviceRole}` },
  }).catch(() => undefined)
}

async function runProbe() {
  if (!productionUrl || !renderApiKey || !renderServiceId) {
    throw new Error('Production UI probe configuration is unavailable')
  }
  const [supabaseUrl, serviceRole] = await Promise.all([
    renderEnv('NEXT_PUBLIC_SUPABASE_URL'),
    renderEnv('SUPABASE_SERVICE_ROLE_KEY'),
  ])
  const email = `stream-ui-probe-${Date.now()}-${randomBytes(4).toString('hex')}@example.com`
  const password = `Probe-${randomBytes(24).toString('base64url')}!`
  let userId = null
  let browser = null

  try {
    const created = await json(await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
      method: 'POST',
      headers: {
        apikey: serviceRole,
        Authorization: `Bearer ${serviceRole}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email, password, email_confirm: true }),
    }), 'Create disposable UI probe user')
    userId = created.id

    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({
      ...devices['Pixel 7'],
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
    })
    const page = await context.newPage()
    page.setDefaultTimeout(120_000)
    await page.goto(productionUrl, { waitUntil: 'domcontentloaded' })
    await page.locator('#login-email').fill(email)
    await page.locator('#login-password').fill(password)
    await page.getByRole('button', { name: '登录', exact: true }).click()
    const composer = page.locator('textarea[placeholder="说点什么……"]')
    await composer.waitFor({ state: 'visible' })

    const baselineEntries = await page.locator('.message-entry').count()
    await page.evaluate(({ baselineEntries }) => {
      const samples = []
      let assistantFoundAt = null
      let firstGrowthAt = null
      let lastGrowthAt = null
      let maximumLength = 0
      let maximumGap = 0
      let maximumGrowth = 0
      const startedAt = performance.now()
      let scheduled = false

      const sample = () => {
        scheduled = false
        const entries = document.querySelectorAll('.message-entry')
        if (entries.length <= baselineEntries) return
        const assistant = entries[entries.length - 1]
        const length = Array.from(assistant.textContent || '').length
        const now = performance.now()
        if (assistantFoundAt === null) assistantFoundAt = now
        if (length <= maximumLength) return
        const growth = length - maximumLength
        const gap = lastGrowthAt === null ? 0 : now - lastGrowthAt
        maximumLength = length
        maximumGrowth = Math.max(maximumGrowth, growth)
        maximumGap = Math.max(maximumGap, gap)
        if (firstGrowthAt === null && length > 12) firstGrowthAt = now
        lastGrowthAt = now
        samples.push({ atMs: Math.round(now - startedAt), length, growth, gapMs: Math.round(gap) })
      }
      const observer = new MutationObserver(() => {
        if (scheduled) return
        scheduled = true
        requestAnimationFrame(sample)
      })
      observer.observe(document.body, { subtree: true, childList: true, characterData: true })
      window.__mychatUiStreamProbe = {
        startedAt,
        samples,
        observer,
        snapshot: () => ({
          visibleChars: maximumLength,
          samples: samples.length,
          firstVisibleMs: firstGrowthAt === null ? null : Math.round(firstGrowthAt - startedAt),
          maxGapMs: Math.round(maximumGap),
          maxGrowthChars: maximumGrowth,
          elapsedMs: Math.round(performance.now() - startedAt),
        }),
      }
    }, { baselineEntries })

    const prompt = '请直接输出一篇不少于2200个中文汉字的连续说明文，主题是人工智能如何改变普通人的学习、工作和生活。不要联网，不要调用任何工具，不要使用代码块，不要使用表格，不要列举序号，不要省略，不要提前结束。正文必须超过2200个中文汉字。'
    await composer.fill(prompt)
    await page.getByRole('button', { name: '发送', exact: true }).click()

    await page.waitForFunction(() => {
      const probe = window.__mychatUiStreamProbe
      return probe && probe.snapshot().visibleChars >= 2200
    }, undefined, { timeout: 8 * 60_000, polling: 250 })

    const metrics = await page.evaluate(() => {
      const probe = window.__mychatUiStreamProbe
      const snapshot = probe.snapshot()
      probe.observer.disconnect()
      return { ...snapshot, tail: probe.samples.slice(-20) }
    })
    const stop = page.getByRole('button', { name: '停止生成', exact: true })
    if (await stop.isVisible().catch(() => false)) await stop.click().catch(() => undefined)

    const failures = []
    if (metrics.visibleChars < 2200) failures.push(`visible ${metrics.visibleChars}<2200`)
    if (metrics.samples < 20) failures.push(`updates ${metrics.samples}<20`)
    if (metrics.maxGapMs > 1500) failures.push(`UI gap ${metrics.maxGapMs}ms>1500ms`)
    if (metrics.maxGrowthChars > 200) failures.push(`UI burst ${metrics.maxGrowthChars}>200 chars`)
    return { ok: failures.length === 0, metrics, error: failures.join(', ') }
  } finally {
    await browser?.close().catch(() => undefined)
    await deleteUser(supabaseUrl, serviceRole, userId)
  }
}

let result
try {
  result = await runProbe()
} catch (error) {
  result = { ok: false, metrics: null, error: error instanceof Error ? error.message : String(error) }
}
await writeFile(resultPath, JSON.stringify(result))
console.log(`STREAM_UI_PROBE_RESULT=${JSON.stringify(result)}`)
if (!result.ok) process.exitCode = 1
