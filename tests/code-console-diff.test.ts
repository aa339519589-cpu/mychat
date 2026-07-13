import assert from "node:assert/strict"
import test from "node:test"

import { computeDiff } from "../components/code-console/diff"

test("computeDiff preserves common lines and identifies replacements", () => {
  assert.deepEqual(computeDiff("alpha\nbeta", "alpha\ngamma"), [
    { type: "same", text: "alpha" },
    { type: "del", text: "beta" },
    { type: "add", text: "gamma" },
  ])
})

test("computeDiff uses a bounded full replacement for oversized inputs", () => {
  const oldText = Array.from({ length: 601 }, (_, index) => `old-${index}`).join("\n")
  const result = computeDiff(oldText, "new")

  assert.equal(result.length, 602)
  assert.equal(result[0].type, "del")
  assert.deepEqual(result.at(-1), { type: "add", text: "new" })
})
