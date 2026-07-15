import { pathToFileURL } from "node:url"

export const REQUIRED_READY_CHECKS = [
  "auth",
  "database",
  "distributedRateLimit",
  "queue",
  "worker",
  "stream",
  "observability",
  "sandbox",
]

function objectOf(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : null
}

function boundedInteger(value, fallback, minimum, maximum, name) {
  const parsed = value == null || value === "" ? fallback : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`)
  }
  return parsed
}

function expectedWorkerDraining(value) {
  if (value === undefined || value === null || value === "" || value === false || value === "false") {
    return false
  }
  if (value === true || value === "true") return true
  throw new Error("EXPECTED_WORKER_DRAINING must be true or false")
}

export function normalizeReadyUrl(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("A production /api/ready URL is required")
  }
  const url = new URL(value)
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("Readiness checks require HTTPS outside loopback")
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/api/ready") {
    throw new Error("Readiness URL must be an origin plus the exact /api/ready path")
  }
  return url
}

export function validateReadyPayload(value, expectedRevision = "", expectedDraining = false) {
  const payload = objectOf(value)
  const checks = objectOf(payload?.checks)
  if (!payload || payload.status !== "ok" || payload.ready !== true || !checks) {
    throw new Error("Runtime did not report strict readiness")
  }
  const revision = payload.revision
  if (typeof revision !== "string" || !/^[a-f0-9]{7,12}$/.test(revision)) {
    throw new Error("Runtime did not report a deployed Git revision")
  }
  const normalizedExpected = expectedRevision.trim().toLowerCase()
  if (normalizedExpected
    && (!/^[a-f0-9]{7,64}$/.test(normalizedExpected)
      || (!normalizedExpected.startsWith(revision) && !revision.startsWith(normalizedExpected)))) {
    throw new Error("Runtime revision does not match the expected deployment")
  }
  for (const name of REQUIRED_READY_CHECKS) {
    const check = objectOf(checks[name])
    if (!check || check.configured !== true || check.ready !== true) {
      throw new Error(`Runtime readiness check failed: ${name}`)
    }
    if (name === "worker" && check.draining !== expectedDraining) {
      throw new Error(
        `Runtime readiness check failed: worker draining check reports a drain state that is not explicitly ${expectedDraining ? "on" : "off"}`,
      )
    }
  }
  return { revision }
}

async function fetchReady(url, timeoutMs, expectedRevision, expectedDraining) {
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (response.status !== 200) throw new Error(`Readiness endpoint returned HTTP ${response.status}`)
  const contentType = response.headers.get("content-type") ?? ""
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new Error("Readiness endpoint did not return JSON")
  }
  return validateReadyPayload(await response.json(), expectedRevision, expectedDraining)
}

export async function checkProductionHealth(options = {}) {
  const url = normalizeReadyUrl(options.url ?? process.env.MYCHAT_HEALTH_URL ?? "")
  const attempts = boundedInteger(
    options.attempts ?? process.env.HEALTH_CHECK_ATTEMPTS,
    5,
    1,
    10,
    "HEALTH_CHECK_ATTEMPTS",
  )
  const timeoutMs = boundedInteger(
    options.timeoutMs ?? process.env.HEALTH_CHECK_TIMEOUT_MS,
    20_000,
    1_000,
    60_000,
    "HEALTH_CHECK_TIMEOUT_MS",
  )
  const retryMs = boundedInteger(
    options.retryMs ?? process.env.HEALTH_CHECK_RETRY_MS,
    10_000,
    0,
    60_000,
    "HEALTH_CHECK_RETRY_MS",
  )
  const expectedRevision = options.expectedRevision
    ?? process.env.EXPECTED_REVISION
    ?? ""
  const expectedDraining = expectedWorkerDraining(
    options.expectedDraining ?? process.env.EXPECTED_WORKER_DRAINING,
  )
  let lastError = new Error("Production readiness was not checked")
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetchReady(url, timeoutMs, expectedRevision, expectedDraining)
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      if (attempt < attempts) {
        console.error(`Readiness attempt ${attempt}/${attempts} failed: ${lastError.message}`)
        await new Promise(resolve => setTimeout(resolve, retryMs))
      }
    }
  }
  throw lastError
}

async function main() {
  const result = await checkProductionHealth({ url: process.argv[2] })
  console.log(`Production runtime is strictly ready at revision ${result.revision}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`Production readiness failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
