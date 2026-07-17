import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8")
}

test("public surfaces present the phone-first Code workflow consistently", () => {
  const layout = source("app/layout.tsx")
  const login = source("components/login-screen.tsx")
  const code = source("components/code-console/presentation.tsx")
  const smoke = source("e2e/smoke.spec.ts")

  assert.match(layout, /MyChat — Build and ship from your phone/)
  assert.doesNotMatch(layout, /generator:\s*['"]v0\.app/)
  assert.match(login, />MyChat</)
  assert.match(login, /Build &amp; ship from your phone/)
  assert.doesNotMatch(login, />简</)
  assert.match(code, /Your phone is the command center/)
  assert.match(code, /max-w-\[42vw\]/)
  assert.match(code, /className="truncate">\{repo\}/)
  assert.equal(smoke.match(/toHaveTitle\(\/MyChat\/\)/g)?.length, 2)
  assert.doesNotMatch(smoke, /toHaveTitle\(\/My Chat\/\)/)
})

test("the public repository carries the Build Week evidence and license", () => {
  const readme = source("README.md")
  const submission = source("docs/BUILD_WEEK_SUBMISSION.md")
  const license = source("LICENSE")

  assert.match(readme, /Built with Codex and GPT-5\.6/)
  assert.match(readme, /c1f22de9da5f7806e39517933e12850de1ed70eb/)
  assert.match(submission, /Your phone is the command center\. The cloud sandbox is the computer\./)
  assert.match(submission, /Codex with GPT-5\.6 Sol/)
  assert.match(submission, /\/feedback/)
  assert.match(license, /^MIT License/)
})
