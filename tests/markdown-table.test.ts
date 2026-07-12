import assert from "node:assert/strict"
import test from "node:test"
import { prepareChatMarkdown, repairCollapsedGfmTables } from "../lib/markdown"

test("repairCollapsedGfmTables inserts newlines between collapsed rows", () => {
  const input =
    "| 平台 | 最新主力模型 | 发布时间 ||------|--------------|------------|| Grok | Grok 4.5 | 2026-07-08 || ChatGPT | GPT-5.6 | 2026-07-09 |"
  const out = repairCollapsedGfmTables(input)
  assert.equal(
    out,
    [
      "| 平台 | 最新主力模型 | 发布时间 |",
      "|------|--------------|------------|",
      "| Grok | Grok 4.5 | 2026-07-08 |",
      "| ChatGPT | GPT-5.6 | 2026-07-09 |",
    ].join("\n"),
  )
})

test("repairCollapsedGfmTables leaves well-formed multi-line tables alone", () => {
  const input = [
    "| A | B |",
    "| --- | --- |",
    "| 1 | 2 |",
  ].join("\n")
  assert.equal(repairCollapsedGfmTables(input), input)
})

test("repairCollapsedGfmTables does not rewrite fenced code", () => {
  const input = "```\n| a || b |\n|------||\n```"
  assert.equal(repairCollapsedGfmTables(input), input)
})

test("prepareChatMarkdown is identity for non-tables", () => {
  assert.equal(prepareChatMarkdown("**hello**\n\n- item"), "**hello**\n\n- item")
})
