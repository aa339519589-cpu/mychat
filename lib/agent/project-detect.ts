import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isRecord } from '@/lib/unknown-value'
import { workspaceRoot } from './workspace'

const workspaceFile = (root: string, name: string) => join(/* turbopackIgnore: true */ root, name)

export type DetectedProject = {
  packageManager: 'npm' | 'pnpm' | 'yarn' | 'bun' | 'unknown'
  framework: 'next' | 'vite' | 'react' | 'node' | 'unknown'
  installCommand: string | null
  lintCommand: string | null
  typecheckCommand: string | null
  testCommand: string | null
  buildCommand: string | null
  scripts: Record<string, string>
  hasTypeScript: boolean
  confidence: number
  notes: string[]
}

type PackageManager = DetectedProject['packageManager']
type Framework = DetectedProject['framework']
type Detection<T> = { value: T; confidence: number; notes: string[] }

function readJson(root: string, path: string): Record<string, unknown> | null {
  const absolutePath = workspaceFile(root, path)
  if (!existsSync(absolutePath)) return null
  try {
    const value: unknown = JSON.parse(readFileSync(absolutePath, 'utf8'))
    return isRecord(value) ? value : null
  } catch {
    return null
  }
}

function hasFile(root: string, names: readonly string[]): boolean {
  return names.some(name => existsSync(workspaceFile(root, name)))
}

function declaredPackageManager(pkg: Record<string, unknown> | null): PackageManager {
  const value = typeof pkg?.packageManager === 'string'
    ? pkg.packageManager.trim().toLowerCase()
    : ''
  for (const manager of ['npm', 'pnpm', 'yarn', 'bun'] as const) {
    if (value === manager || value.startsWith(`${manager}@`)) return manager
  }
  return 'unknown'
}

function detectPackageManager(
  root: string,
  pkg: Record<string, unknown> | null,
): Detection<PackageManager> {
  const locks: Array<[PackageManager, readonly string[]]> = [
    ['pnpm', ['pnpm-lock.yaml']],
    ['yarn', ['yarn.lock']],
    ['bun', ['bun.lock', 'bun.lockb']],
    ['npm', ['package-lock.json', 'npm-shrinkwrap.json']],
  ]
  for (const [manager, names] of locks) {
    if (hasFile(root, names)) return { value: manager, confidence: 10, notes: [] }
  }
  const declared = declaredPackageManager(pkg)
  if (declared !== 'unknown') return { value: declared, confidence: 5, notes: [] }
  return {
    value: pkg ? 'npm' : 'unknown',
    confidence: pkg ? 5 : 0,
    notes: [],
  }
}

function packageScripts(pkg: Record<string, unknown> | null): Detection<Record<string, string>> {
  const source = isRecord(pkg?.scripts) ? pkg.scripts : null
  const scripts: Record<string, string> = {}
  for (const [name, value] of Object.entries(source ?? {})) {
    if (typeof value === 'string') scripts[name] = value
  }
  return {
    value: scripts,
    confidence: Object.keys(scripts).length > 0 ? 15 : 0,
    notes: [],
  }
}

function packageDependencies(pkg: Record<string, unknown> | null): Set<string> {
  const dependencies = new Set<string>()
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
    const values = isRecord(pkg?.[field]) ? pkg[field] : null
    for (const name of Object.keys(values ?? {})) dependencies.add(name)
  }
  return dependencies
}

function detectFramework(root: string, dependencies: Set<string>): Detection<Framework> {
  if (hasFile(root, ['next.config.js', 'next.config.mjs', 'next.config.cjs', 'next.config.ts'])
    || dependencies.has('next')) {
    return { value: 'next', confidence: 15, notes: [] }
  }
  if (hasFile(root, [
    'vite.config.js', 'vite.config.mjs', 'vite.config.cjs',
    'vite.config.ts', 'vite.config.mts', 'vite.config.cts',
  ]) || dependencies.has('vite')) {
    return { value: 'vite', confidence: 10, notes: [] }
  }
  if (dependencies.has('react') || dependencies.has('react-dom')) {
    return { value: 'react', confidence: 5, notes: [] }
  }
  return { value: 'node', confidence: 3, notes: [] }
}

function runPrefix(packageManager: PackageManager): string {
  if (packageManager === 'yarn') return 'yarn'
  if (packageManager === 'pnpm') return 'pnpm'
  if (packageManager === 'bun') return 'bun run'
  return 'npm run'
}

function installCommand(root: string, packageManager: PackageManager): string {
  if (packageManager === 'yarn') return 'yarn install --ignore-scripts'
  if (packageManager === 'pnpm') return 'pnpm install --ignore-scripts'
  if (packageManager === 'bun') return 'bun install --ignore-scripts'
  return hasFile(root, ['package-lock.json', 'npm-shrinkwrap.json'])
    ? 'npm install --ignore-scripts'
    : 'npm install --ignore-scripts --no-package-lock'
}

function detectLint(root: string, scripts: Record<string, string>, prefix: string): Detection<string | null> {
  if (scripts.lint) return { value: `${prefix} lint`, confidence: 5, notes: [] }
  if (scripts['lint:check'] || scripts['lint:ci']) {
    const name = scripts['lint:check'] ? 'lint:check' : 'lint:ci'
    return { value: `${prefix} ${name}`, confidence: 3, notes: [] }
  }
  if (hasFile(root, [
    'eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts',
    '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json', '.eslintrc.yaml', '.eslintrc.yml',
  ])) {
    return { value: 'npx eslint .', confidence: 2, notes: ['lint: 未找到 lint script，使用 npx eslint .'] }
  }
  if (hasFile(root, ['biome.json', 'biome.jsonc'])) {
    return { value: 'npx @biomejs/biome check .', confidence: 2, notes: ['lint: 使用 biome'] }
  }
  return { value: null, confidence: 0, notes: [] }
}

function detectTypecheck(
  scripts: Record<string, string>,
  prefix: string,
  hasTypeScript: boolean,
): Detection<string | null> {
  if (scripts.typecheck) return { value: `${prefix} typecheck`, confidence: 5, notes: [] }
  if (scripts['type-check']) return { value: `${prefix} type-check`, confidence: 5, notes: [] }
  if (scripts.tsc) return { value: `${prefix} tsc`, confidence: 3, notes: [] }
  if (hasTypeScript) {
    return {
      value: 'npx tsc --noEmit',
      confidence: 2,
      notes: ['typecheck: 未找到 typecheck script，使用 npx tsc --noEmit'],
    }
  }
  return { value: null, confidence: 0, notes: [] }
}

function detectTest(root: string, scripts: Record<string, string>, prefix: string): Detection<string | null> {
  if (scripts.test) return { value: `${prefix} test`, confidence: 5, notes: [] }
  if (scripts['test:ci'] || scripts['test:run']) {
    const name = scripts['test:ci'] ? 'test:ci' : 'test:run'
    return { value: `${prefix} ${name}`, confidence: 3, notes: [] }
  }
  if (hasFile(root, [
    'vitest.config.js', 'vitest.config.mjs', 'vitest.config.cjs',
    'vitest.config.ts', 'vitest.config.mts', 'vitest.config.cts',
  ])) {
    return { value: 'npx vitest run', confidence: 2, notes: ['test: 未找到 test script，使用 npx vitest run'] }
  }
  if (hasFile(root, [
    'jest.config.js', 'jest.config.mjs', 'jest.config.cjs',
    'jest.config.ts', 'jest.config.json',
  ])) {
    return { value: 'npx jest --runInBand', confidence: 2, notes: ['test: 未找到 test script，使用 npx jest --runInBand'] }
  }
  return { value: null, confidence: 0, notes: [] }
}

function detectBuild(
  scripts: Record<string, string>,
  prefix: string,
  framework: Framework,
): Detection<string | null> {
  if (scripts.build) return { value: `${prefix} build`, confidence: 5, notes: [] }
  if (framework !== 'next') return { value: null, confidence: 0, notes: [] }
  const command = `${prefix} build`
  return { value: command, confidence: 3, notes: [`build: Next.js 项目，使用 ${command}`] }
}

export function detectProjectCommands(taskId: string, userId: string): DetectedProject {
  const root = workspaceRoot(taskId, userId)
  const pkg = readJson(root, 'package.json')
  const manager = detectPackageManager(root, pkg)
  const scripts = packageScripts(pkg)
  const dependencies = packageDependencies(pkg)
  const framework = detectFramework(root, dependencies)
  const hasTypeScript = hasFile(root, ['tsconfig.json']) || dependencies.has('typescript')
  const prefix = runPrefix(manager.value)
  const lint = detectLint(root, scripts.value, prefix)
  const typecheck = detectTypecheck(scripts.value, prefix, hasTypeScript)
  const test = detectTest(root, scripts.value, prefix)
  const build = detectBuild(scripts.value, prefix, framework.value)
  const detections = [manager, scripts, framework, lint, typecheck, test, build]
  const confidence = 50
    + detections.reduce((total, detection) => total + detection.confidence, 0)
    + (hasTypeScript ? 10 : 0)
  return {
    packageManager: manager.value,
    framework: framework.value,
    installCommand: hasFile(root, ['node_modules']) ? null : installCommand(root, manager.value),
    lintCommand: lint.value,
    typecheckCommand: typecheck.value,
    testCommand: test.value,
    buildCommand: build.value,
    scripts: scripts.value,
    hasTypeScript,
    confidence: Math.min(confidence, 100),
    notes: detections.flatMap(detection => detection.notes),
  }
}
