import test from 'node:test'
import assert from 'node:assert/strict'
import { parseArtifact, sanitizeSvg } from '../lib/artifact'
import { makeContentFilter } from '../lib/llm/content-filter'

test('parseArtifact hides trailing partial artifact tag prefixes from markdown text', () => {
  const parsed = parseArtifact('先看这张图\n\n<veg')
  assert.equal(parsed.display, '先看这张图')
  assert.equal(parsed.vegaRaw, null)
})

test('parseArtifact keeps unfinished vega specs out of display text', () => {
  const parsed = parseArtifact('图表如下：\n<vega>\n{"mark":"line"')
  assert.equal(parsed.display, '图表如下：')
  assert.equal(parsed.vegaDone, false)
  assert.match(parsed.vegaRaw ?? '', /"mark":"line"/)
})

test('parseArtifact returns closed vega specs as renderable artifacts', () => {
  const parsed = parseArtifact('图表如下：\n<vega>\n{"mark":"bar"}\n</vega>\n结论。')
  assert.equal(parsed.display, '图表如下：\n\n结论。')
  assert.equal(parsed.vegaDone, true)
  assert.equal(parsed.vegaRaw, '{"mark":"bar"}')
})

test('sanitizeSvg closes unfinished svg fragments defensively', () => {
  const clean = sanitizeSvg('<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"')
  assert.ok(clean?.endsWith('</svg>'))
  assert.match(clean ?? '', /<svg/)
})

test('sanitizeSvg keeps safe vector primitives and removes active or remote content', () => {
  const clean = sanitizeSvg(`<svg width="100" height="50" onload="alert(1)">
    <defs><linearGradient id="paint"><stop offset="0" stop-color="#fff" /></linearGradient></defs>
    <rect width="100" height="50" fill="url(#paint)" />
    <rect width="10" height="10" fill="url(https://evil.test/paint)" style="background:url(https://evil.test/x)" />
    <script>alert(1)</script><foreignObject><iframe src="https://evil.test"></iframe></foreignObject>
    <image href="https://evil.test/pixel" /><use href="#paint" /><animate attributeName="x" />
    <style>@import url(https://evil.test/style.css)</style>
  </svg>`)

  assert.match(clean ?? '', /<linearGradient id="paint">/)
  assert.match(clean ?? '', /fill="url\(#paint\)"/)
  assert.doesNotMatch(clean ?? '', /script|foreignObject|iframe|<image|<use|animate|<style/i)
  assert.doesNotMatch(clean ?? '', /onload|https:|javascript:|style=/i)
})

test('stream filter discards an unfinished tool block instead of leaking arguments', () => {
  const filter = makeContentFilter()
  const visible = filter.feed('安全正文<｜DSML｜tool_calls>{"secret":"do-not-leak"}') + filter.flush()
  assert.equal(visible, '安全正文')
  assert.doesNotMatch(visible, /secret|do-not-leak/)
})
