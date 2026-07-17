import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import test from "node:test"

const checker = resolve(process.cwd(), "scripts/check-architecture.mjs")

function runFixture(files: Record<string, string>, arguments_: string[] = []) {
  const root = mkdtempSync(join(tmpdir(), "mychat-architecture-"))
  try {
    for (const [path, source] of Object.entries(files)) {
      const absolutePath = join(root, path)
      mkdirSync(dirname(absolutePath), { recursive: true })
      writeFileSync(absolutePath, source)
    }
    return spawnSync(process.execPath, [checker, "--root", root, ...arguments_], { encoding: "utf8" })
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

test("architecture checker reports local dependency fan-in and fan-out", () => {
  const result = runFixture({
    "lib/domain.ts": "export const answer = 42\n",
    "components/result.tsx": "import { answer } from '@/lib/domain'\nexport const Result = () => <p>{answer}</p>\n",
    "app/page.tsx": "import { Result } from '@/components/result'\nimport { answer } from '@/lib/domain'\nexport default function Page() { return <Result key={answer} /> }\n",
  }, ["--json"])

  assert.equal(result.status, 0, result.stderr)
  const report = JSON.parse(result.stdout) as {
    metrics: Array<{ path: string; localDependencies: number; localDependents: number }>
  }
  const metrics = new Map(report.metrics.map(metric => [metric.path, metric]))
  assert.equal(metrics.get("lib/domain.ts")?.localDependencies, 0)
  assert.equal(metrics.get("lib/domain.ts")?.localDependents, 2)
  assert.equal(metrics.get("app/page.tsx")?.localDependencies, 2)
  assert.equal(metrics.get("app/page.tsx")?.localDependents, 0)
})

test("architecture checker rejects library modules owned only by tests", () => {
  const result = runFixture({
    "app/page.tsx": "export default function Page() { return null }\n",
    "lib/obsolete.ts": "export const obsolete = true\n",
  })

  assert.equal(result.status, 1)
  assert.match(result.stderr, /unused-runtime-module/)
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

test("architecture checker discovers server-only marker modules", () => {
  const result = runFixture({
    "lib/secrets.ts": "import 'server-only'\nexport const secret = 'hidden'\n",
    "components/leak.tsx": "import { secret } from '@/lib/secrets'\nexport const Leak = () => <p>{secret}</p>\n",
  })

  assert.equal(result.status, 1)
  assert.match(result.stderr, /client-server-import/)
})

test("architecture checker propagates Node runtime boundaries", () => {
  const result = runFixture({
    "lib/runtime.ts": "import { readFileSync } from 'node:fs'\nexport const secret = readFileSync('/tmp/key', 'utf8')\n",
    "lib/bridge.ts": "export { secret } from './runtime'\n",
    "components/leak.tsx": "import { secret } from '@/lib/bridge'\nexport const Leak = () => <p>{secret}</p>\n",
  })

  assert.equal(result.status, 1)
  assert.match(result.stderr, /client-server-path/)
})

test("architecture checker propagates private-environment boundaries", () => {
  const result = runFixture({
    "lib/runtime.ts": "export const secret = process.env.PRIVATE_KEY\n",
    "lib/bridge.ts": "export { secret } from './runtime'\n",
    "components/leak.tsx": "import { secret } from '@/lib/bridge'\nexport const Leak = () => <p>{secret}</p>\n",
  })

  assert.equal(result.status, 1)
  assert.match(result.stderr, /client-server-path/)
})

test("architecture checker allows explicitly public environment variables in clients", () => {
  const result = runFixture({
    "components/public.tsx": "'use client'\nexport const Public = () => <p>{process.env.NEXT_PUBLIC_LABEL}</p>\n",
  })

  assert.equal(result.status, 0, result.stderr)
})

test("architecture checker includes root proxy entries in server paths", () => {
  const result = runFixture({
    "proxy.ts": "import { browserValue } from './lib/bridge'\nexport const proxy = () => browserValue\n",
    "lib/bridge.ts": "export { browserValue } from './data/browser'\n",
    "lib/data/browser.ts": "export const browserValue = window.location.href\n",
  })

  assert.equal(result.status, 1)
  assert.match(result.stderr, /server-client-path/)
})

test("architecture checker prevents generic LLM code from depending on agents", () => {
  const result = runFixture({
    "lib/agent/policy.ts": "export const policy = () => true\n",
    "lib/llm/turn.ts": "import { policy } from '../agent/policy'\nexport const run = policy\n",
  })

  assert.equal(result.status, 1)
  assert.match(result.stderr, /domain-direction/)
})

test("architecture checker prevents API routes from running a complete LLM loop", () => {
  const result = runFixture({
    "lib/llm/agent-loop.ts": "export const runAgentLoop = async () => undefined\n",
    "app/api/chat/route.ts": "import { runAgentLoop } from '@/lib/llm/agent-loop'\nexport const POST = runAgentLoop\n",
  })

  assert.equal(result.status, 1)
  assert.match(result.stderr, /api-execution-boundary/)
  assert.match(result.stderr, /lib\/llm\/agent-loop\.ts/)
})

test("architecture checker keeps deep provider transports behind worker-owned facades", () => {
  const result = runFixture({
    "lib/llm/openai-compatible/safe-fetch.ts": "export const safeModelEndpointFetch = fetch\n",
    "app/api/chat/route.ts": "import { safeModelEndpointFetch } from '@/lib/llm/openai-compatible/safe-fetch'\nexport const POST = safeModelEndpointFetch\n",
  })

  assert.equal(result.status, 1)
  assert.match(result.stderr, /api-execution-boundary/)
  assert.match(result.stderr, /openai-compatible\/safe-fetch\.ts/)
})

test("architecture checker rejects process and E2B execution imports in API routes", async t => {
  for (const specifier of ["node:child_process", "child_process", "e2b", "e2b/sandbox"]) {
    await t.test(specifier, () => {
      const result = runFixture({
        "app/api/chat/route.ts": `import runtime from '${specifier}'\nexport const POST = runtime\n`,
      })

      assert.equal(result.status, 1)
      assert.match(result.stderr, /api-execution-boundary/)
      assert.match(result.stderr, new RegExp(specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    })
  }
})

test("architecture checker allows API routes to enqueue through a command facade", () => {
  const result = runFixture({
    "lib/chat/job-command.ts": "export const enqueueChatJob = async () => ({ id: 'job' })\n",
    "app/api/chat/route.ts": "import { enqueueChatJob } from '@/lib/chat/job-command'\nexport const POST = enqueueChatJob\n",
  })

  assert.equal(result.status, 0, result.stderr)
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
