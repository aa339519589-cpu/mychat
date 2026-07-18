import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { test } from "node:test"

function requireBlock(source: string, pattern: RegExp, label: string) {
  const match = source.match(pattern)
  assert.ok(match?.[1], `${label} block is missing`)
  return match[1]
}

test("light and dark themes use separate emphasis palettes", async () => {
  const css = await readFile(new URL("../app/theme-palette.css", import.meta.url), "utf8")
  const light = requireBlock(css, /^:root\s*\{([\s\S]*?)\n\}/m, "light theme")
  const manualDark = requireBlock(css, /\.dark\s*\{([\s\S]*?)\n\}/, "manual dark theme")
  const automaticDark = requireBlock(
    css,
    /@media \(prefers-color-scheme: dark\) \{[\s\S]*?:root:not\(\.light\)\s*\{([\s\S]*?)\n  \}/,
    "automatic dark theme",
  )

  assert.match(light, /--primary:\s*#011A38;/)
  assert.match(light, /--sidebar-primary:\s*#011A38;/)
  assert.match(light, /--sidebar-accent:\s*rgb\(1 26 56 \/ 7%\);/)

  for (const dark of [manualDark, automaticDark]) {
    assert.match(dark, /--primary:\s*#2F6FB3;/)
    assert.match(dark, /--sidebar-primary:\s*#2F6FB3;/)
    assert.match(dark, /--sidebar-accent:\s*rgb\(47 111 179 \/ 18%\);/)
    assert.match(dark, /--ring:\s*#79B8F3;/)
    assert.doesNotMatch(dark, /--primary:\s*#011A38;/)
  }
})
