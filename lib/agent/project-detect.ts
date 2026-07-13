// 项目命令识别：根据 workspace 文件判断 packageManager / framework / 可用命令

import { existsSync, readFileSync } from "fs"
import { join } from "path"
import { workspaceRoot } from "./workspace"
import { isRecord } from '@/lib/unknown-value'

const workspaceFile = (root: string, name: string) => join(/* turbopackIgnore: true */ root, name)

export type DetectedProject = {
  packageManager: "npm" | "pnpm" | "yarn" | "bun" | "unknown"
  framework: "next" | "vite" | "react" | "node" | "unknown"
  installCommand: string | null
  lintCommand: string | null
  typecheckCommand: string | null
  testCommand: string | null
  buildCommand: string | null
  scripts: Record<string, string>  // raw package.json scripts
  hasTypeScript: boolean
  confidence: number  // 0-100
  notes: string[]
}

function readJson(root: string, path: string): Record<string, unknown> | null {
  const abs = workspaceFile(root, path)
  if (!existsSync(abs)) return null
  try { return JSON.parse(readFileSync(abs, "utf-8")) } catch { return null }
}

export function detectProjectCommands(taskId: string, userId: string): DetectedProject {
  const root = workspaceRoot(taskId, userId)
  const notes: string[] = []
  let confidence = 50

  // ── Package manager ──
  let packageManager: DetectedProject["packageManager"] = "unknown"
  if (existsSync(workspaceFile(root, "pnpm-lock.yaml"))) { packageManager = "pnpm"; confidence += 10 }
  else if (existsSync(workspaceFile(root, "yarn.lock"))) { packageManager = "yarn"; confidence += 10 }
  else if (existsSync(workspaceFile(root, "bun.lockb"))) { packageManager = "bun"; confidence += 10 }
  else if (existsSync(workspaceFile(root, "package-lock.json"))) { packageManager = "npm"; confidence += 10 }
  else if (existsSync(workspaceFile(root, "package.json"))) { packageManager = "npm"; confidence += 5 }

  // ── Read package.json ──
  const pkg = readJson(root, "package.json")
  const scripts: Record<string, string> = {}
  if (pkg) {
    const source = isRecord(pkg.scripts) ? pkg.scripts : null
    if (source) {
      for (const [name, value] of Object.entries(source)) {
        if (typeof value === 'string') scripts[name] = value
      }
    }
    if (Object.keys(scripts).length > 0) confidence += 15
  }

  // ── Framework ──
  let framework: DetectedProject["framework"] = "unknown"
  const deps = new Set<string>()
  if (pkg) {
    for (const k of ["dependencies", "devDependencies", "peerDependencies"]) {
      const obj = isRecord(pkg[k]) ? pkg[k] : null
      if (obj) Object.keys(obj).forEach(d => deps.add(d))
    }
  }

  if (existsSync(workspaceFile(root, "next.config.js")) || existsSync(workspaceFile(root, "next.config.mjs")) || existsSync(workspaceFile(root, "next.config.ts")) || deps.has("next")) {
    framework = "next"; confidence += 15
  } else if (existsSync(workspaceFile(root, "vite.config.js")) || existsSync(workspaceFile(root, "vite.config.mjs")) || existsSync(workspaceFile(root, "vite.config.ts")) || deps.has("vite")) {
    framework = "vite"; confidence += 10
  } else if (deps.has("react") || deps.has("react-dom")) {
    framework = "react"; confidence += 5
  } else {
    framework = "node"; confidence += 3
  }

  // ── TypeScript ──
  const hasTypeScript = existsSync(workspaceFile(root, "tsconfig.json")) || deps.has("typescript")
  if (hasTypeScript) confidence += 10

  // ── Commands from scripts ──
  const runPrefix = packageManager === "yarn" ? "yarn" : packageManager === "pnpm" ? "pnpm" : packageManager === "bun" ? "bun run" : "npm run"

  // install
  const npmInstall = existsSync(workspaceFile(root, "package-lock.json")) ? "npm install" : "npm install --no-package-lock"
  const installCommand = packageManager === "yarn"
    ? "yarn"
    : packageManager === "pnpm"
      ? "pnpm install"
      : packageManager === "bun"
        ? "bun install"
        : npmInstall

  // lint
  let lintCommand: string | null = null
  if (scripts.lint) { lintCommand = `${runPrefix} lint`; confidence += 5 }
  else if (scripts["lint:check"] || scripts["lint:ci"]) { lintCommand = `${runPrefix} ${scripts["lint:check"] ? "lint:check" : "lint:ci"}`; confidence += 3 }
  else if (existsSync(workspaceFile(root, "eslint.config.js")) || existsSync(workspaceFile(root, "eslint.config.mjs")) || existsSync(workspaceFile(root, ".eslintrc.js")) || existsSync(workspaceFile(root, ".eslintrc.json"))) {
    lintCommand = `npx eslint .`; confidence += 2; notes.push("lint: 未找到 lint script，使用 npx eslint .")
  } else if (existsSync(workspaceFile(root, "biome.json"))) {
    lintCommand = `npx @biomejs/biome check .`; confidence += 2; notes.push("lint: 使用 biome")
  }

  // typecheck
  let typecheckCommand: string | null = null
  if (scripts.typecheck) { typecheckCommand = `${runPrefix} typecheck`; confidence += 5 }
  else if (scripts["type-check"]) { typecheckCommand = `${runPrefix} type-check`; confidence += 5 }
  else if (scripts["tsc"]) { typecheckCommand = `${runPrefix} tsc`; confidence += 3 }
  else if (hasTypeScript) {
    typecheckCommand = `npx tsc --noEmit`; confidence += 2; notes.push("typecheck: 未找到 typecheck script，使用 npx tsc --noEmit")
  }

  // test
  let testCommand: string | null = null
  if (scripts.test) { testCommand = `${runPrefix} test`; confidence += 5 }
  else if (scripts["test:ci"] || scripts["test:run"]) { testCommand = `${runPrefix} ${scripts["test:ci"] ? "test:ci" : "test:run"}`; confidence += 3 }
  else if (existsSync(workspaceFile(root, "vitest.config.js")) || existsSync(workspaceFile(root, "vitest.config.ts")) || existsSync(workspaceFile(root, "jest.config.js")) || existsSync(workspaceFile(root, "jest.config.ts"))) {
    testCommand = `npx vitest run`; confidence += 2; notes.push("test: 未找到 test script，使用 npx vitest run")
  }

  // build
  let buildCommand: string | null = null
  if (scripts.build) { buildCommand = `${runPrefix} build`; confidence += 5 }
  else if (framework === "next") { buildCommand = `${runPrefix} build`; confidence += 3; notes.push("build: Next.js 项目，使用 npm run build") }

  return {
    packageManager,
    framework,
    installCommand: existsSync(workspaceFile(root, "node_modules")) ? null : installCommand, // 已安装就跳过
    lintCommand,
    typecheckCommand,
    testCommand,
    buildCommand,
    scripts,
    hasTypeScript,
    confidence: Math.min(confidence, 100),
    notes,
  }
}
