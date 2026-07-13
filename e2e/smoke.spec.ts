import { expect, test, type Page } from '@playwright/test'

const USER_ID = '10000000-0000-4000-8000-000000000001'
const CONVERSATION_A = '20000000-0000-4000-8000-000000000001'
const CONVERSATION_B = '20000000-0000-4000-8000-000000000002'

const corsHeaders = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, apikey, content-type, prefer, x-client-info',
  'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'content-type': 'application/json',
}

async function mockAuthenticatedWorkspace(page: Page) {
  const now = new Date().toISOString()
  const user = {
    id: USER_ID,
    aud: 'authenticated',
    role: 'authenticated',
    email: 'architect@example.test',
    email_confirmed_at: now,
    app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: {},
    identities: [],
    created_at: now,
  }
  const session = {
    access_token: 'e2e-access-token',
    refresh_token: 'e2e-refresh-token',
    token_type: 'bearer',
    expires_in: 86_400,
    expires_at: Math.floor(Date.now() / 1000) + 86_400,
    user,
  }
  const encoded = `base64-${Buffer.from(JSON.stringify(session)).toString('base64url')}`
  await page.addInitScript(({ value }) => {
    document.cookie = `sb-example-auth-token=${value}; path=/; SameSite=Lax`
  }, { value: encoded })

  await page.route('**/api/endpoints', route => route.fulfill({
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoints: [] }),
  }))
  await page.route('**/api/generations/running?*', route => route.fulfill({
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ generations: [] }),
  }))
  await page.route('https://example.supabase.co/**', route => {
    const request = route.request()
    const url = new URL(request.url())
    if (request.method() === 'OPTIONS') {
      return route.fulfill({ status: 204, headers: corsHeaders })
    }
    if (url.pathname === '/auth/v1/user') {
      return route.fulfill({ status: 200, headers: corsHeaders, body: JSON.stringify(user) })
    }
    if (url.pathname === '/auth/v1/token') {
      return route.fulfill({ status: 200, headers: corsHeaders, body: JSON.stringify(session) })
    }
    if (!url.pathname.startsWith('/rest/v1/')) {
      return route.fulfill({ status: 404, headers: corsHeaders, body: '{}' })
    }
    if (request.method() !== 'GET') {
      return route.fulfill({ status: 200, headers: corsHeaders, body: '{}' })
    }

    const table = url.pathname.slice('/rest/v1/'.length)
    if (table === 'conversations') {
      return route.fulfill({ status: 200, headers: corsHeaders, body: JSON.stringify([
        { id: CONVERSATION_A, title: 'Alpha', updated_at: now, project_id: null, starred: false, pinned: true, messages: [{ count: 2 }] },
        { id: CONVERSATION_B, title: 'Beta', updated_at: now, project_id: null, starred: false, pinned: false, messages: [{ count: 2 }] },
      ]) })
    }
    if (table === 'messages') {
      const conversation = url.searchParams.get('conversation_id')?.replace(/^eq\./, '')
      const isBeta = conversation === CONVERSATION_B
      return route.fulfill({ status: 200, headers: corsHeaders, body: JSON.stringify([
        { id: isBeta ? '30000000-0000-4000-8000-000000000003' : '30000000-0000-4000-8000-000000000001', role: 'user', content: isBeta ? 'beta prompt' : 'alpha prompt', images: null, thinking: null, created_at: now },
        { id: isBeta ? '30000000-0000-4000-8000-000000000004' : '30000000-0000-4000-8000-000000000002', role: 'assistant', content: isBeta ? 'beta answer' : 'alpha answer', images: null, thinking: null, created_at: now },
      ]) })
    }
    if (table === 'profiles') {
      return route.fulfill({ status: 200, headers: corsHeaders, body: JSON.stringify({ memory_enabled: true }) })
    }
    return route.fulfill({ status: 200, headers: corsHeaders, body: '[]' })
  })
}

test('root page reaches the authentication shell without client exceptions', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', error => pageErrors.push(error.message))

  await page.goto('/', { waitUntil: 'domcontentloaded' })

  await expect(page).toHaveTitle(/My Chat/)
  await expect(page.getByPlaceholder('邮箱')).toBeVisible()
  await expect(page.getByRole('button', { name: '登录', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '以游客身份继续' })).toBeVisible()
  expect(pageErrors).toEqual([])
})

test('conversation deep links preserve the application shell', async ({ page }) => {
  await page.goto('/c/550e8400-e29b-41d4-a716-446655440000', { waitUntil: 'domcontentloaded' })

  await expect(page).toHaveTitle(/My Chat/)
  await expect(page.getByPlaceholder('邮箱')).toBeVisible()
})

test('authenticated shell uses one responsive tree and synchronizes browser history', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', error => pageErrors.push(error.message))
  await mockAuthenticatedWorkspace(page)
  await page.goto(`/c/${CONVERSATION_A}`, { waitUntil: 'domcontentloaded' })

  await expect(page.getByPlaceholder('说点什么……')).toHaveCount(1)
  await expect(page.locator('main')).toHaveCount(1)
  await expect(page.locator('aside').filter({ has: page.getByText('My Chat', { exact: true }) })).toHaveCount(1)

  if ((page.viewportSize()?.width ?? 0) < 768) {
    await page.getByRole('button', { name: '打开对话列表' }).click()
  }
  await page.locator('aside').getByRole('button').filter({ hasText: 'Beta' }).click()
  await expect(page).toHaveURL(new RegExp(`/c/${CONVERSATION_B}$`))
  await expect(page.getByText('beta answer', { exact: true })).toBeVisible()

  if ((page.viewportSize()?.width ?? 0) < 768) {
    await page.getByRole('button', { name: '打开对话列表' }).click()
  }
  await page.locator('aside').getByRole('button').filter({ hasText: 'Alpha' }).click()
  await expect(page).toHaveURL(new RegExp(`/c/${CONVERSATION_A}$`))

  await page.goBack()
  await expect(page).toHaveURL(new RegExp(`/c/${CONVERSATION_B}$`))
  await page.goBack()
  await expect(page).toHaveURL(new RegExp(`/c/${CONVERSATION_A}$`))
  expect(pageErrors).toEqual([])
})
