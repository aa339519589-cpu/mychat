import assert from "node:assert/strict"
import test from "node:test"
import { articleWordCount, localDateParts } from "../lib/article-data"

test("localDateParts observes the configured timezone across UTC date boundaries", () => {
  assert.deepEqual(localDateParts(new Date("2026-07-11T03:30:00.000Z"), "America/Chicago"), { date: "2026-07-10", hour: 22 })
  assert.deepEqual(localDateParts(new Date("2026-07-11T11:00:00.000Z"), "America/Chicago"), { date: "2026-07-11", hour: 6 })
})

test("articleWordCount counts whitespace-delimited English words", () => {
  assert.equal(articleWordCount("One considered sentence.\n\nAnd another short one."), 7)
  assert.equal(articleWordCount("   "), 0)
})
