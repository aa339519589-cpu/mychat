import { expect, test } from '@playwright/test'

const NONCE = /'nonce-([A-Za-z0-9+/_-]+={0,2})'/

test('HTML responses use unique nonces on every framework script', async ({ page, request }) => {
  const first = await request.get('/')
  const second = await request.get('/')
  expect(first.ok()).toBe(true)
  expect(second.ok()).toBe(true)

  const firstPolicy = first.headers()['content-security-policy'] ?? ''
  const secondPolicy = second.headers()['content-security-policy'] ?? ''
  const firstNonce = firstPolicy.match(NONCE)?.[1]
  const secondNonce = secondPolicy.match(NONCE)?.[1]
  expect(firstNonce).toMatch(/^[a-f0-9]{32}$/)
  expect(secondNonce).toMatch(/^[a-f0-9]{32}$/)
  expect(secondNonce).not.toBe(firstNonce)
  expect(firstPolicy).toContain("'strict-dynamic'")
  expect(firstPolicy).not.toMatch(/script-src[^;]*'unsafe-inline'/)
  expect(first.headers()['cache-control']).toContain('private')
  expect(first.headers()['cache-control']).toContain('no-store')

  const html = await first.text()
  const scriptNonces = await page.evaluate(markup => {
    const parsed = new DOMParser().parseFromString(markup, 'text/html')
    return [...parsed.scripts].map(script => script.getAttribute('nonce'))
  }, html)
  expect(scriptNonces.length).toBeGreaterThan(0)
  for (const nonce of scriptNonces) expect(nonce).toBe(firstNonce)

  const pageErrors: string[] = []
  page.on('pageerror', error => pageErrors.push(error.message))
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect(page.getByPlaceholder('邮箱')).toBeVisible()
  expect(pageErrors).toEqual([])
})
