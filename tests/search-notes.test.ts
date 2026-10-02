import assert from "node:assert/strict"
import test from "node:test"

import { normalizeSearchNotes } from "../lib/search-notes"

test("search note normalization retains bounded rich cards and safe images", () => {
  const [note] = normalizeSearchNotes([{
    kind: "image",
    query: "  red panda  ",
    results: [
      {
        title: "Red panda facts",
        url: "https://example.com/pandas",
        snippet: "  A short source summary.  ",
        published_at: "  2026-10-02  ",
        favicon_url: "https://example.com/icon.png",
        thumbnail_url: "https://example.com/panda.jpg",
      },
      { title: "unsafe icon", url: "https://example.com/unsafe", favicon_url: "javascript:alert(1)" },
      { title: "credential URL", url: "https://user:pass@example.com/secret" },
    ],
    images: [
      { url: "https://images.example/panda.jpg", description: "  A red panda  " },
      { url: "javascript:alert(1)", description: "not an image" },
      { url: "https://user:pass@images.example/private.jpg" },
    ],
  }])

  assert.deepEqual(note, {
    kind: "image",
    query: "  red panda  ",
    results: [
      {
        title: "Red panda facts",
        url: "https://example.com/pandas",
        snippet: "A short source summary.",
        published_at: "2026-10-02",
        favicon_url: "https://example.com/icon.png",
        thumbnail_url: "https://example.com/panda.jpg",
      },
      { title: "unsafe icon", url: "https://example.com/unsafe" },
    ],
    images: [{ url: "https://images.example/panda.jpg", description: "A red panda" }],
  })
})

test("legacy search notes remain readable with safe defaults", () => {
  assert.deepEqual(normalizeSearchNotes([{
    query: "stable source",
    results: [{ title: "Docs", url: "https://example.com/docs" }],
  }]), [{
    kind: "web",
    query: "stable source",
    results: [{ title: "Docs", url: "https://example.com/docs" }],
    images: [],
  }])
})
