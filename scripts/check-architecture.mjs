#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { builtinModules } from "node:module"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import process from "node:process"
import ts from "typescript"

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]
const SOURCE_DIRECTORIES = ["app", "components", "lib"]
const NODE_BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
])

const DEFAULT_BUDGETS = {
  app: { maxLines: 300, maxLocalDependencies: 18 },
  components: { maxLines: 350, maxLocalDependencies: 18 },
  lib: { maxLines: 400, maxLocalDependencies: 18 },
}

function parseArguments(argv) {
  const result = { root: process.cwd(), config: undefined, json: false }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === "--root") result.root = resolve(argv[++index])
    else if (argument === "--config") result.config = resolve(argv[++index])
    else if (argument === "--json") result.json = true
    else throw new Error(`Unknown argument: ${argument}`)
  }
  result.root = resolve(result.root)
  result.config ??= join(result.root, "scripts", "architecture-baseline.json")
  return result
}

function normalizePath(path) {
  return path.split(sep).join("/")
}

function walk(directory) {
  if (!existsSync(directory)) return []
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...walk(path))
    else if (SOURCE_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) files.push(path)
  }
  return files
}

function sourceFiles(root) {
  return SOURCE_DIRECTORIES.flatMap((directory) => walk(join(root, directory)))
    .map((absolutePath) => ({
      absolutePath,
      path: normalizePath(relative(root, absolutePath)),
      source: readFileSync(absolutePath, "utf8"),
    }))
    .sort((left, right) => left.path.localeCompare(right.path))
}

function isTypeOnlyImport(node) {
  if (ts.isImportDeclaration(node)) {
    const clause = node.importClause
    if (!clause) return false
    if (clause.isTypeOnly) return true
    if (clause.name) return false
    return ts.isNamedImports(clause.namedBindings)
      && clause.namedBindings.elements.length > 0
      && clause.namedBindings.elements.every((element) => element.isTypeOnly)
  }
  if (ts.isExportDeclaration(node)) {
    if (node.isTypeOnly) return true
    return Boolean(
      node.exportClause
      && ts.isNamedExports(node.exportClause)
      && node.exportClause.elements.length > 0
      && node.exportClause.elements.every((element) => element.isTypeOnly),
    )
  }
  return false
}

function importsFor(file) {
  const kind = file.path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sourceFile = ts.createSourceFile(file.path, file.source, ts.ScriptTarget.Latest, true, kind)
  const imports = []

  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier
      && ts.isStringLiteral(node.moduleSpecifier)) {
      imports.push({
        specifier: node.moduleSpecifier.text,
        typeOnly: isTypeOnlyImport(node),
        line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
      })
    } else if (ts.isCallExpression(node)
      && node.arguments.length === 1
      && ts.isStringLiteral(node.arguments[0])
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      imports.push({
        specifier: node.arguments[0].text,
        typeOnly: false,
        line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
      })
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return imports
}

function resolveLocalImport(root, sourcePath, specifier) {
  let candidate
  if (specifier.startsWith("@/")) candidate = join(root, specifier.slice(2))
  else if (specifier.startsWith(".")) candidate = resolve(root, dirname(sourcePath), specifier)
  else return undefined

  const candidates = [
    candidate,
    ...SOURCE_EXTENSIONS.map((extension) => `${candidate}${extension}`),
    ...SOURCE_EXTENSIONS.map((extension) => join(candidate, `index${extension}`)),
  ]
  const match = candidates.find((path) => existsSync(path) && statSync(path).isFile())
  return match ? normalizePath(relative(root, match)) : undefined
}

function isServerOnly(path) {
  return path.startsWith("lib/api/")
    || (path.startsWith("lib/agent/") && path !== "lib/agent/types.ts")
    || path.startsWith("lib/code-tools/")
    || path.startsWith("lib/tools/")
    || path === "lib/supabase/server.ts"
    || path === "lib/github-session.ts"
    || path === "lib/model-endpoint-server.ts"
    || path === "lib/model-endpoint-secret.ts"
    || path === "lib/quota.ts"
    || path === "lib/rate-limit.ts"
    || path === "lib/generation/persist.ts"
    || path === "lib/generation/runtime.ts"
}

function isBrowserOnly(path) {
  return path.startsWith("lib/data/")
    || path === "lib/supabase/client.ts"
    || path === "lib/code-data.ts"
    || path === "lib/media-storage.ts"
}

function layerFor(path) {
  if (path.startsWith("app/")) return "app"
  if (path.startsWith("components/")) return "components"
  return "lib"
}

function lineCount(source) {
  if (source.length === 0) return 0
  const lines = source.split(/\r?\n/)
  return lines.at(-1) === "" ? lines.length - 1 : lines.length
}

function stronglyConnectedComponents(graph) {
  let nextIndex = 0
  const indices = new Map()
  const lowLinks = new Map()
  const stack = []
  const onStack = new Set()
  const components = []

  function connect(node) {
    indices.set(node, nextIndex)
    lowLinks.set(node, nextIndex)
    nextIndex += 1
    stack.push(node)
    onStack.add(node)

    for (const dependency of graph.get(node) ?? []) {
      if (!indices.has(dependency)) {
        connect(dependency)
        if (onStack.has(dependency)) {
          lowLinks.set(node, Math.min(lowLinks.get(node), lowLinks.get(dependency)))
        }
      } else if (onStack.has(dependency)) {
        lowLinks.set(node, Math.min(lowLinks.get(node), indices.get(dependency)))
      }
    }

    if (lowLinks.get(node) === indices.get(node)) {
      const component = []
      let current
      do {
        current = stack.pop()
        onStack.delete(current)
        component.push(current)
      } while (current !== node)
      components.push(component.sort())
    }
  }

  for (const node of graph.keys()) if (!indices.has(node)) connect(node)
  return components.filter((component) => component.length > 1
    || (graph.get(component[0]) ?? []).includes(component[0]))
}

function shortestPath(graph, start, predicate) {
  const queue = [[start]]
  const visited = new Set([start])
  while (queue.length > 0) {
    const path = queue.shift()
    const current = path.at(-1)
    for (const dependency of graph.get(current) ?? []) {
      if (visited.has(dependency)) continue
      const nextPath = [...path, dependency]
      if (predicate(dependency)) return nextPath
      visited.add(dependency)
      queue.push(nextPath)
    }
  }
  return undefined
}

function loadConfig(path) {
  if (!existsSync(path)) return {}
  return JSON.parse(readFileSync(path, "utf8"))
}

function cycleKey(cycle) {
  return [...cycle].sort().join("|")
}

function violation(code, path, line, message) {
  return { code, path, line, message }
}

function inspect(root, config) {
  const files = sourceFiles(root)
  const filePaths = new Set(files.map((file) => file.path))
  const imports = new Map()
  const graph = new Map(files.map((file) => [file.path, []]))
  const violations = []

  for (const file of files) {
    const resolvedImports = importsFor(file).map((entry) => ({
      ...entry,
      target: resolveLocalImport(root, file.path, entry.specifier),
    }))
    imports.set(file.path, resolvedImports)
    graph.set(file.path, [...new Set(resolvedImports
      .filter((entry) => !entry.typeOnly && entry.target && filePaths.has(entry.target))
      .map((entry) => entry.target))])

    for (const entry of resolvedImports) {
      const target = entry.target
      if (file.path.startsWith("components/")
        && !entry.typeOnly
        && (NODE_BUILTINS.has(entry.specifier) || entry.specifier === "next/server" || entry.specifier === "next/headers")) {
        violations.push(violation(
          "client-node-import",
          file.path,
          entry.line,
          `client UI imports server runtime \"${entry.specifier}\"`,
        ))
      }
      if (!target) continue
      if (file.path.startsWith("lib/") && (target.startsWith("app/") || target.startsWith("components/"))) {
        violations.push(violation("reverse-layer", file.path, entry.line, `lib must not depend on ${target}`))
      }
      if (file.path.startsWith("app/api/") && target.startsWith("components/")) {
        violations.push(violation("api-ui-import", file.path, entry.line, `API routes must not depend on UI module ${target}`))
      }
      if (file.path.startsWith("components/") && target.startsWith("app/")) {
        violations.push(violation("ui-app-import", file.path, entry.line, `UI must not depend on Next.js entry module ${target}`))
      }
      if (file.path.startsWith("components/") && !entry.typeOnly && isServerOnly(target)) {
        violations.push(violation("client-server-import", file.path, entry.line, `client UI imports server-only module ${target}`))
      }
      if ((file.path.startsWith("app/api/") || isServerOnly(file.path)) && !entry.typeOnly && isBrowserOnly(target)) {
        violations.push(violation("server-client-import", file.path, entry.line, `server module imports browser-only module ${target}`))
      }
    }
  }


  for (const file of files) {
    if (file.path.startsWith("components/")) {
      const path = shortestPath(graph, file.path, isServerOnly)
      if (path && path.length > 2) {
        violations.push(violation(
          "client-server-path",
          file.path,
          undefined,
          `client UI reaches server-only code through ${path.join(" -> ")}`,
        ))
      }
    }
    if (file.path.startsWith("app/api/")) {
      const path = shortestPath(graph, file.path, isBrowserOnly)
      if (path && path.length > 2) {
        violations.push(violation(
          "server-client-path",
          file.path,
          undefined,
          `API route reaches browser-only code through ${path.join(" -> ")}`,
        ))
      }
    }
  }

  const budgets = config.budgets ?? {}
  const exceptions = config.exceptions ?? {}
  const metrics = []
  for (const file of files) {
    const layer = layerFor(file.path)
    const defaultBudget = { ...DEFAULT_BUDGETS[layer], ...(budgets[layer] ?? {}) }
    const budget = { ...defaultBudget, ...(exceptions[file.path] ?? {}) }
    const lines = lineCount(file.source)
    const localDependencies = new Set((imports.get(file.path) ?? [])
      .map((entry) => entry.target)
      .filter(Boolean)).size
    metrics.push({
      path: file.path,
      lines,
      localDependencies,
      maxLines: budget.maxLines,
      maxLocalDependencies: budget.maxLocalDependencies,
    })
    if (lines > budget.maxLines) {
      violations.push(violation(
        "line-budget",
        file.path,
        undefined,
        `${lines} lines exceeds the ${budget.maxLines}-line budget`,
      ))
    }
    if (localDependencies > budget.maxLocalDependencies) {
      violations.push(violation(
        "dependency-budget",
        file.path,
        undefined,
        `${localDependencies} local dependencies exceeds the budget of ${budget.maxLocalDependencies}`,
      ))
    }
  }

  const metricsByPath = new Map(metrics.map((item) => [item.path, item]))
  for (const [path, exception] of Object.entries(exceptions)) {
    const metric = metricsByPath.get(path)
    if (!metric) {
      violations.push(violation("stale-exception", path, undefined, "budget exception points to a missing file"))
      continue
    }
    const defaultBudget = { ...DEFAULT_BUDGETS[layerFor(path)], ...(budgets[layerFor(path)] ?? {}) }
    if (exception.maxLines !== undefined) {
      if (metric.lines <= defaultBudget.maxLines) {
        violations.push(violation(
          "stale-exception",
          path,
          undefined,
          `line count is within the default ${defaultBudget.maxLines}-line budget; remove the exception`,
        ))
      } else if (metric.lines < exception.maxLines) {
        violations.push(violation(
          "stale-exception",
          path,
          undefined,
          `line count fell to ${metric.lines}; lower the exception from ${exception.maxLines}`,
        ))
      }
    }
    if (exception.maxLocalDependencies !== undefined) {
      if (metric.localDependencies <= defaultBudget.maxLocalDependencies) {
        violations.push(violation(
          "stale-exception",
          path,
          undefined,
          `dependency count is within the default budget of ${defaultBudget.maxLocalDependencies}; remove the exception`,
        ))
      } else if (metric.localDependencies < exception.maxLocalDependencies) {
        violations.push(violation(
          "stale-exception",
          path,
          undefined,
          `local dependency count fell to ${metric.localDependencies}; lower the exception from ${exception.maxLocalDependencies}`,
        ))
      }
    }
  }

  const allowedCycles = new Set((config.allowedCycles ?? []).map(cycleKey))
  const cycles = stronglyConnectedComponents(graph)
  const actualCycles = new Set(cycles.map(cycleKey))
  for (const cycle of cycles) {
    if (!allowedCycles.has(cycleKey(cycle))) {
      violations.push(violation("dependency-cycle", cycle[0], undefined, `runtime cycle: ${cycle.join(" -> ")}`))
    }
  }
  for (const cycle of config.allowedCycles ?? []) {
    if (!actualCycles.has(cycleKey(cycle))) {
      violations.push(violation(
        "stale-cycle-exception",
        [...cycle].sort()[0] ?? "scripts/architecture-baseline.json",
        undefined,
        `allowed runtime cycle no longer exists: ${[...cycle].sort().join(" -> ")}`,
      ))
    }
  }

  return {
    files: files.length,
    runtimeEdges: [...graph.values()].reduce((total, dependencies) => total + dependencies.length, 0),
    cycles,
    metrics,
    violations: violations.sort((left, right) => left.path.localeCompare(right.path)
      || (left.line ?? 0) - (right.line ?? 0)
      || left.code.localeCompare(right.code)),
  }
}

function main() {
  const options = parseArguments(process.argv.slice(2))
  const config = loadConfig(options.config)
  const result = inspect(options.root, config)
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } else if (result.violations.length === 0) {
    console.log(`Architecture check passed: ${result.files} files, ${result.runtimeEdges} runtime edges, ${result.cycles.length} baseline cycles.`)
  } else {
    console.error(`Architecture check failed with ${result.violations.length} violation(s):`)
    for (const item of result.violations) {
      const location = item.line ? `${item.path}:${item.line}` : item.path
      console.error(`- [${item.code}] ${location} — ${item.message}`)
    }
  }
  process.exitCode = result.violations.length === 0 ? 0 : 1
}

main()
