import assert from "node:assert/strict"
import test from "node:test"
import {
  changedFileBadge,
  displayedDiff,
  failedVerificationErrors,
  statusColor,
  statusLabel,
} from "../components/agent-tasks/status"
import type { VerifyData } from "../components/agent-tasks/types"

test("task status presentation supports known and future states", () => {
  assert.equal(statusLabel("running"), "运行中")
  assert.equal(statusColor("failed"), "text-red-400")
  assert.equal(statusLabel("paused_by_policy"), "paused_by_policy")
  assert.equal(statusColor("paused_by_policy"), "text-muted-foreground")
})

test("changed file badges preserve the diff status contract", () => {
  assert.deepEqual(changedFileBadge("added"), { label: "A", className: "text-green-400" })
  assert.deepEqual(changedFileBadge("modified"), { label: "M", className: "text-yellow-400" })
  assert.deepEqual(changedFileBadge("deleted"), { label: "D", className: "text-red-400" })
  assert.deepEqual(changedFileBadge("renamed"), { label: "?" })
})

test("large diffs are truncated at the display boundary", () => {
  assert.equal(displayedDiff("short", 8), "short")
  assert.equal(displayedDiff("123456789", 8), "12345678\n\n... (截断)")
})

test("verification preview selects the first failing non-skipped step", () => {
  const result: VerifyData = {
    ok: false,
    failedStep: "typecheck",
    totalDurationMs: 25,
    summary: "failed",
    steps: [
      {
        name: "lint",
        command: null,
        skipped: true,
        passed: false,
        durationMs: 0,
        parsedErrors: { totalErrors: 0, totalWarnings: 0, summary: "skipped", errors: [] },
      },
      {
        name: "typecheck",
        command: "tsc --noEmit",
        skipped: false,
        passed: false,
        durationMs: 25,
        parsedErrors: {
          totalErrors: 4,
          totalWarnings: 0,
          summary: "four errors",
          errors: Array.from({ length: 4 }, (_, index) => ({
            file: `file-${index}.ts`,
            line: index + 1,
            message: `error ${index}`,
            severity: "error",
          })),
        },
      },
    ],
  }

  assert.deepEqual(
    failedVerificationErrors(result).map(error => error.file),
    ["file-0.ts", "file-1.ts", "file-2.ts"],
  )
})
