import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import test from "node:test"

const checker = resolve(process.cwd(), "scripts/check-architecture.mjs")

function runFixture(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "mychat-architecture-"))
  try {
    for (const [path, source] of Object.entries(files)) {
      const absolutePath = join(root, path)
      mkdirSync(dirname(absolutePath), { recursive: true })
      writeFileSync(absolutePath, source)
    }
    return spawnSync(process.execPath, [checker, "--root", root], { encoding: "utf8" })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test("architecture checker accepts a valid dependency direction", () => {
  const result = runFixture({
    "lib/domain.ts": "export const answer = 42\n",
    "components/result.tsx": "import { answer } from '@/lib/domain'\nexport const Result = () => <p>{answer}</p>\n",
    "app/page.tsx": "import { Result } from '@/components/result'\nexport default function Page() { return <Result /> }\n",
  })

  assert.equal(result.status, 0, result.stderr)
})

test("architecture checker rejects client imports of server-only modules", () => {
  const result = runFixture({
    "lib/api/secret.ts": "export const secret = 'server-only'\n",
    "components/leak.tsx": "import { secret } from '@/lib/api/secret'\nexport const Leak = () => <p>{secret}</p>\n",
  })

  assert.equal(result.status, 1)
  assert.match(result.stderr, /client-server-import/)
})

test("architecture checker rejects transitive client-to-server paths", () => {
  const result = runFixture({
    "lib/api/secret.ts": "export const secret = 'server-only'\n",
    "lib/bridge.ts": "export { secret } from './api/secret'\n",
    "components/leak.tsx": "import { secret } from '@/lib/bridge'\nexport const Leak = () => <p>{secret}</p>\n",
  })

  assert.equal(result.status, 1)
  assert.match(result.stderr, /client-server-path/)
})

test("architecture checker rejects new runtime cycles", () => {
  const result = runFixture({
    "lib/one.ts": "import { two } from './two'\nexport const one = two\n",
    "lib/two.ts": "import { one } from './one'\nexport const two = one\n",
  })

  assert.equal(result.status, 1)
  assert.match(result.stderr, /dependency-cycle/)
})

test("architecture checker removes stale cycle exceptions", () => {
  const result = runFixture({
    "lib/one.ts": "import { two } from './two'\nexport const one = two\n",
    "lib/two.ts": "export const two = 2\n",
    "scripts/architecture-baseline.json": JSON.stringify({
      allowedCycles: [["lib/one.ts", "lib/two.ts"]],
    }),
  })

  assert.equal(result.status, 1)
  assert.match(result.stderr, /stale-cycle-exception/)
})

test("architecture checker rejects oversized new files", () => {
  const result = runFixture({
    "components/oversized.tsx": `${Array.from({ length: 351 }, (_, index) => `// ${index}`).join("\n")}\n`,
  })

  assert.equal(result.status, 1)
  assert.match(result.stderr, /line-budget/)
})

test("architecture checker forces legacy budgets down after code shrinks", () => {
  const result = runFixture({
    "components/legacy.tsx": `${Array.from({ length: 351 }, (_, index) => `// ${index}`).join("\n")}\n`,
    "scripts/architecture-baseline.json": JSON.stringify({
      exceptions: {
        "components/legacy.tsx": { maxLines: 400 },
      },
    }),
  })

  assert.equal(result.status, 1)
  assert.match(result.stderr, /stale-exception/)
})
