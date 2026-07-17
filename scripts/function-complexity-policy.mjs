export const FUNCTION_COMPLEXITY_THRESHOLDS = Object.freeze({
  complexity: 15,
  maxLines: 80,
})

const METRICS = ['complexity', 'maxLines']

function sortedMetrics(values) {
  return [...values].sort((left, right) => right - left)
}

export function buildFunctionComplexityBaseline(files) {
  return {
    version: 1,
    thresholds: FUNCTION_COMPLEXITY_THRESHOLDS,
    files: Object.fromEntries(Object.entries(files)
      .filter(([, metrics]) => METRICS.some(metric => metrics[metric]?.length > 0))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([path, metrics]) => [path, {
        ...(metrics.complexity?.length ? { complexity: sortedMetrics(metrics.complexity) } : {}),
        ...(metrics.maxLines?.length ? { maxLines: sortedMetrics(metrics.maxLines) } : {}),
      }])),
  }
}

function equalMetrics(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function metricRegressed(current, baseline) {
  return current.length > baseline.length
    || current.some((value, index) => value > (baseline[index] ?? Number.NEGATIVE_INFINITY))
}

export function compareFunctionComplexity(current, baseline) {
  const errors = []
  if (baseline?.version !== 1) errors.push('baseline version must be 1')
  if (baseline?.thresholds?.complexity !== FUNCTION_COMPLEXITY_THRESHOLDS.complexity
    || baseline?.thresholds?.maxLines !== FUNCTION_COMPLEXITY_THRESHOLDS.maxLines) {
    errors.push('baseline thresholds do not match the enforced policy')
  }
  const baselineFiles = baseline?.files && typeof baseline.files === 'object'
    ? baseline.files
    : {}
  const paths = new Set([...Object.keys(current), ...Object.keys(baselineFiles)])
  for (const path of [...paths].sort()) {
    for (const metric of METRICS) {
      const actual = sortedMetrics(current[path]?.[metric] ?? [])
      const expected = sortedMetrics(baselineFiles[path]?.[metric] ?? [])
      if (equalMetrics(actual, expected)) continue
      if (metricRegressed(actual, expected)) {
        errors.push(`${path} ${metric} regressed: [${expected}] -> [${actual}]`)
      } else {
        errors.push(`${path} ${metric} improved: lower the baseline [${expected}] -> [${actual}]`)
      }
    }
  }
  return errors
}
