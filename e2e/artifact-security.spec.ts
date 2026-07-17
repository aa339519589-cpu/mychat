import { expect, test } from '@playwright/test'
import { buildArtifactFrameDocument } from '../components/artifact-frame'

test('artifact iframe blocks script execution and network egress', async ({ page }) => {
  const externalAttempts: string[] = []
  const blockedAttempts: Array<{ url: string; error: string }> = []
  const externalResponses: string[] = []
  page.on('request', request => {
    if (request.url().startsWith('https://evil.example/')) externalAttempts.push(request.url())
  })
  page.on('requestfailed', request => {
    if (request.url().startsWith('https://evil.example/')) {
      blockedAttempts.push({ url: request.url(), error: request.failure()?.errorText ?? '' })
    }
  })
  page.on('response', response => {
    if (response.url().startsWith('https://evil.example/')) externalResponses.push(response.url())
  })

  const token = 'a'.repeat(48)
  const srcDoc = buildArtifactFrameDocument(
    { fg: '#111111', bg: '#ffffff', scheme: 'light' },
    true,
    token,
  )
  const hostileHtml = `<style>@import url(https://evil.example/style.css);</style>
    <h1 id="safe-content">Rendered safely</h1>
    <img src="https://evil.example/pixel.png" onerror="globalThis.artifactCompromised='event'">
    <script>globalThis.artifactCompromised='script';fetch('https://evil.example/fetch')</script>`

  await page.setContent('<iframe id="artifact" sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe>')
  await page.evaluate(async ({ documentHtml, channelToken, payload }) => {
    const iframe = document.getElementById('artifact') as HTMLIFrameElement | null
    if (!iframe) throw new Error('artifact iframe missing')
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error('artifact handshake timed out')), 5_000)
      iframe.addEventListener('load', () => {
        const channel = new MessageChannel()
        channel.port1.onmessage = event => {
          if (event.data?.type !== 'ready') return
          channel.port1.postMessage({ type: 'final', html: payload })
          window.setTimeout(() => {
            clearTimeout(timeout)
            channel.port1.close()
            resolve()
          }, 250)
        }
        channel.port1.start()
        iframe.contentWindow?.postMessage(
          { type: 'connect', token: channelToken },
          '*',
          [channel.port2],
        )
      }, { once: true })
      iframe.srcdoc = documentHtml
    })
  }, { documentHtml: srcDoc, channelToken: token, payload: hostileHtml })

  const artifact = page.frames().find(frame => frame !== page.mainFrame())
  if (!artifact) throw new Error('artifact frame did not attach')
  await expect(artifact.locator('#safe-content')).toHaveText('Rendered safely')
  assertNoArtifactCompromise(await artifact.evaluate(() => (
    globalThis as typeof globalThis & { artifactCompromised?: string }
  ).artifactCompromised))
  expect(externalAttempts.length).toBeGreaterThan(0)
  expect(externalResponses).toEqual([])
  expect(blockedAttempts).toHaveLength(externalAttempts.length)
  for (const attempt of blockedAttempts) expect(attempt.error).toMatch(/csp|blocked/i)
})

function assertNoArtifactCompromise(value: unknown): void {
  expect(value).toBeUndefined()
}
