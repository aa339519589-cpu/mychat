import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildFunctionComplexityBaseline,
  compareFunctionComplexity,
} from '../scripts/function-complexity-policy.mjs'

const current = {
  'lib/legacy.ts': { complexity: [22, 18], maxLines: [120] },
}

test('function complexity policy produces deterministic descending baselines', () => {
  assert.deepEqual(buildFunctionComplexityBaseline({
    'lib/legacy.ts': { complexity: [18, 22], maxLines: [120] },
    'lib/clean.ts': {},
  }), {
    version: 1,
    thresholds: { complexity: 15, maxLines: 80 },
    files: {
      'lib/legacy.ts': { complexity: [22, 18], maxLines: [120] },
    },
  })
})

test('function complexity policy rejects new and worsening exceptions', () => {
  const baseline = buildFunctionComplexityBaseline(current)
  assert.deepEqual(compareFunctionComplexity(current, baseline), [])
  assert.match(compareFunctionComplexity({
    ...current,
    'lib/new.ts': { complexity: [16] },
  }, baseline).join('\n'), /lib\/new\.ts complexity regressed/)
  assert.match(compareFunctionComplexity({
    'lib/legacy.ts': { complexity: [23, 18], maxLines: [120] },
  }, baseline).join('\n'), /complexity regressed/)
})

test('function complexity policy requires every improvement to ratchet the baseline down', () => {
  const baseline = buildFunctionComplexityBaseline(current)
  const errors = compareFunctionComplexity({
    'lib/legacy.ts': { complexity: [18], maxLines: [100] },
  }, baseline)
  assert.equal(errors.length, 2)
  assert.match(errors.join('\n'), /complexity improved/)
  assert.match(errors.join('\n'), /maxLines improved/)
})
