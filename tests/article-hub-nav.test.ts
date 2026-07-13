import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const hubSource = readFileSync(join(process.cwd(), "components/article-hub.tsx"), "utf8")
const cssSource = readFileSync(join(process.cwd(), "app/globals.css"), "utf8")

test("article reader uses a bottom-local hero scrim rather than a full-bleed black wash", () => {
  assert.match(hubSource, /tone === "reader"/)
  assert.match(hubSource, /h-\[42%\]/)
  assert.doesNotMatch(
    hubSource,
    /ArticleReader[\s\S]*absolute inset-0 bg-\[linear-gradient\(to_top,rgba\(14,14,13,\.78\)/,
  )
})

test("article detail keeps a 44px safe-area back control and history integration", () => {
  assert.match(hubSource, /min-h-\[44px\]/)
  assert.match(hubSource, /env\(safe-area-inset-top\)/)
  assert.match(hubSource, /history\.pushState/)
  assert.match(hubSource, /popstate/)
  assert.match(hubSource, /Back to daily brief/)
  assert.match(hubSource, /Exit articles and return to chat/)
})

test("reader cover grain is lighter than the default cover texture", () => {
  assert.match(cssSource, /\.article-cover--reader::after/)
  assert.match(cssSource, /\.article-cover--reader::after\s*\{[^}]*opacity:\s*\.0[0-9]/)
})
