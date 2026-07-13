import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8")
}

test("the responsive chat shell mounts one sidebar and one chat pane", () => {
  const view = source("components/literary-chat/literary-chat-view.tsx")
  const pane = source("components/literary-chat/chat-pane.tsx")
  assert.equal(view.match(/<AppSidebar\b/g)?.length, 1)
  assert.equal(view.match(/<ChatPane\b/g)?.length, 1)
  assert.equal(pane.match(/<ChatInput\b/g)?.length, 1)
  assert.match(view, /dynamic<CodeConsoleProps>/)
  assert.match(view, /useMediaQuery\("\(max-width: 767px\)"\)/)
})

test("artifact navigation is explicit and heavy charts stay lazy", () => {
  const overlay = source("components/artifact-library-overlay.tsx")
  const sidebar = source("components/app-sidebar.tsx")
  const vega = source("components/vega-chart.tsx")
  assert.doesNotMatch(overlay, /MutationObserver|document\.addEventListener\("click"/)
  assert.match(sidebar, /openArtifacts\(\)/)
  assert.match(sidebar, />My Chat</)
  assert.match(vega, /await import\("vega-embed"\)/)
  assert.doesNotMatch(vega, /import vegaEmbed from/)
})

test("assistant placeholders must persist before any durable generation starts", () => {
  const send = source("components/literary-chat/use-chat-generation.ts")
  const regenerate = source("components/literary-chat/message-regeneration.ts")

  for (const implementation of [send, regenerate]) {
    assert.doesNotMatch(
      implementation,
      /insertMessage\([^\n]+(?:assistantMessage|replacement)\)\.catch\(/,
    )
  }
  assert.ok(
    send.indexOf("await insertMessage(user.id, conversationId, assistantMessage)")
      < send.indexOf("const result = await startStream"),
  )
  assert.ok(
    regenerate.indexOf("await insertMessage(user.id, activeId, replacement)")
      < regenerate.indexOf("await startStream(history"),
  )
  assert.ok(
    regenerate.indexOf("await insertMessage(user.id, conversationId, assistantMessage)")
      < regenerate.indexOf("await startStream(retainedMessages"),
  )
})
