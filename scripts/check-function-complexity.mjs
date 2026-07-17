#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { ESLint } from 'eslint'
import {
  buildFunctionComplexityBaseline,
  compareFunctionComplexity,
  FUNCTION_COMPLEXITY_THRESHOLDS,
} from './function-complexity-policy.mjs'

const SOURCE_PATTERNS = ['app', 'components', 'lib', 'job-worker.ts', 'proxy.ts']
const BASELINE_PATH = 'scripts/function-complexity-baseline.json'

function normalizePath(root, path) {
  return relative(root, path).split(sep).join('/')
}

function messageMetric(message) {
  if (message.ruleId === 'complexity') {
    return Number(message.message.match(/complexity of (\d+)/)?.[1] ?? Number.NaN)
  }
  if (message.ruleId === 'max-lines-per-function') {
    return Number(message.message.match(/\((\d+)\)/)?.[1] ?? Number.NaN)
  }
  return Number.NaN
}

async function currentMeasurements(root) {
  const eslint = new ESLint({
    cwd: root,
    overrideConfig: {
      rules: {
        complexity: ['error', FUNCTION_COMPLEXITY_THRESHOLDS.complexity],
        'max-lines-per-function': ['error', {
          max: FUNCTION_COMPLEXITY_THRESHOLDS.maxLines,
          skipBlankLines: true,
          skipComments: true,
          IIFEs: true,
        }],
      },
    },
  })
  const results = await eslint.lintFiles(SOURCE_PATTERNS)
  const files = {}
  for (const result of results) {
    const path = normalizePath(root, result.filePath)
    for (const message of result.messages) {
      const metric = messageMetric(message)
      if (!Number.isFinite(metric)) continue
      const name = message.ruleId === 'complexity' ? 'complexity' : 'maxLines'
      files[path] ??= {}
      files[path][name] ??= []
      files[path][name].push(metric)
    }
  }
  return files
}

async function main() {
  const root = process.cwd()
  const current = await currentMeasurements(root)
  const generated = buildFunctionComplexityBaseline(current)
  if (process.argv.includes('--print-baseline')) {
    process.stdout.write(`${JSON.stringify(generated, null, 2)}\n`)
    return
  }
  const baseline = JSON.parse(readFileSync(resolve(root, BASELINE_PATH), 'utf8'))
  const errors = compareFunctionComplexity(current, baseline)
  if (errors.length > 0) {
    for (const error of errors) process.stderr.write(`[function-complexity] ${error}\n`)
    process.stderr.write('Run npm run complexity:baseline and lower the checked-in baseline after an intentional improvement.\n')
    process.exitCode = 1
    return
  }
  const complexity = Object.values(current).flatMap(metrics => metrics.complexity ?? [])
  const maxLines = Object.values(current).flatMap(metrics => metrics.maxLines ?? [])
  process.stdout.write(
    `Function complexity check passed: ${complexity.length} complexity and ${maxLines.length} length exceptions; maxima ${Math.max(0, ...complexity)}/${Math.max(0, ...maxLines)}.\n`,
  )
}

await main()
