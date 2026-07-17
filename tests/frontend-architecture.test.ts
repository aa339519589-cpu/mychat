import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8")
}

function sourceTree(path: string): string {
  const root = fileURLToPath(new URL(`../${path}`, import.meta.url))
  const files: string[] = []
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const fullPath = join(directory, entry.name)
      if (entry.isDirectory()) visit(fullPath)
      else if (/\.(?:ts|tsx)$/.test(entry.name)) files.push(fullPath)
    }
  }
  visit(root)
  return files.sort().map(file => readFileSync(file, "utf8")).join("\n")
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

test("all chat branch mutations persist atomically before the browser changes its view", () => {
  const send = source("components/literary-chat/use-chat-generation.ts")
  const regenerate = source("components/literary-chat/message-regeneration.ts")

  assert.doesNotMatch(send, /insertConversation|insertMessage/)
  assert.match(send, /const turn: ChatTurnAuthority/)
  assert.match(send, /createConversation: wasDraft/)
  assert.match(send, /const result = await startStream\([\s\S]*turn, onAccepted/)
  assert.doesNotMatch(regenerate,
    /insertMessage|deleteMessageRow|deleteMessageRows|updateMessageContent/)
  assert.equal(regenerate.match(/schemaVersion: 2/g)?.length, 2)
  assert.match(regenerate, /operation: 'replace-assistant'/)
  assert.match(regenerate, /operation: 'replace-from-user'/)
  assert.equal(regenerate.match(/authority, \(\) => \{/g)?.length, 2)
  assert.match(regenerate,
    /authority, \(\) => \{[\s\S]*?accepted = true[\s\S]*?cacheConversationMessages/)
})

test("browser chat code cannot directly mutate authoritative message rows", () => {
  const browserChat = sourceTree("components/literary-chat")

  assert.doesNotMatch(
    browserChat,
    /\.from\(["']messages["']\)\s*\.\s*(?:insert|update|upsert|delete)\s*\(/,
  )
  assert.doesNotMatch(
    browserChat,
    /\b(?:insertMessage|updateMessageContent|deleteMessageRow|deleteMessageRows)\s*\(/,
  )
})
