import { readdir } from "node:fs/promises"
import { join, relative, resolve } from "node:path"
import { spawnSync } from "node:child_process"

const root = resolve(process.cwd(), "tests")

async function collectTests(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []

  for (const entry of entries) {
    const fullPath = join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...await collectTests(fullPath))
    } else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      files.push(fullPath)
    }
  }

  return files
}

let tests
try {
  tests = (await collectTests(root)).sort()
} catch (error) {
  console.error(`Unable to discover tests: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

if (tests.length === 0) {
  console.error("No test files were found under tests/.")
  process.exit(1)
}

const executable = join(process.cwd(), "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx")
const displayNames = tests.map(file => relative(process.cwd(), file))
console.log(`Running ${tests.length} test file${tests.length === 1 ? "" : "s"}: ${displayNames.join(", ")}`)

const result = spawnSync(executable, ["--test", ...tests], {
  cwd: process.cwd(),
  stdio: "inherit",
  env: process.env,
})

if (result.error) {
  console.error(result.error.message)
  process.exit(1)
}

process.exit(result.status ?? 1)
