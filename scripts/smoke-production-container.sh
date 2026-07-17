#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
image_ref="${1:-}"
verified_sha="${2:-}"
if [[ -z "$image_ref" || ! "$verified_sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "usage: smoke-production-container.sh IMAGE_REF VERIFIED_SHA" >&2
  exit 2
fi

test "$(docker image inspect \
  --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' \
  "$image_ref")" = "$verified_sha"
docker image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$image_ref" \
  | grep --fixed-strings --line-regexp "MYCHAT_BUILD_REVISION=$verified_sha"
test "$(docker image inspect --format '{{json .Config.Cmd}}' "$image_ref")" = '["npm","start"]'

expected_contract="$(node -e '
  const manifest = require(process.argv[1])
  process.stdout.write(JSON.stringify({
    version: manifest.contractVersion,
    digest: manifest.contractDigest,
    migrationCount: manifest.migrationCount,
  }))
' "$ROOT/supabase/migrations.manifest.json")"
installed_contract="$(docker run --rm --entrypoint node "$image_ref" -e '
  const manifest = require("/app/supabase/migrations.manifest.json")
  process.stdout.write(JSON.stringify({
    version: manifest.contractVersion,
    digest: manifest.contractDigest,
    migrationCount: manifest.migrationCount,
  }))
')"
if [[ "$installed_contract" != "$expected_contract" ]]; then
  echo "Container migration contract does not match the verified checkout" >&2
  exit 1
fi

container="mychat-smoke-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}-${RANDOM}"
cleanup() { docker rm --force "$container" >/dev/null 2>&1 || true; }
trap cleanup EXIT
# These deterministic placeholders exist only to exercise the fail-closed
# production contract. They are deliberately low-entropy and cannot authorize
# access to any external service.
docker run --detach --name "$container" \
  --publish 127.0.0.1:3000:3000 \
  --env NEXT_PUBLIC_SUPABASE_URL=https://example.supabase.co \
  --env NEXT_PUBLIC_SUPABASE_ANON_KEY=ci-public-anon-key \
  --env SUPABASE_SERVICE_ROLE_KEY=00000000000000000000000000000000 \
  --env STREAM_ADMISSION_HASH_KEY=11111111111111111111111111111111 \
  --env E2B_API_KEY=ci-container-smoke \
  --env DEEPSEEK_API_KEY=ci-deepseek-key \
  --env AGENT_CREDENTIAL_KEY=22222222222222222222222222222222 \
  --env AGENT_PUBLIC_URL=https://mychat.example \
  --env GITHUB_CLIENT_ID=ci-github-client \
  --env GITHUB_CLIENT_SECRET=33333333333333333333333333333333 \
  --env METRICS_BEARER_TOKEN=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef \
  --env MYCHAT_MAINTENANCE_MODE=drain \
  --env MYCHAT_RUNTIME_ROLE=all \
  "$image_ref" >/dev/null

assert_runtime() {
  if ! docker inspect --format '{{.State.Running}}' "$container" 2>/dev/null | grep -qx true; then
    docker logs "$container" >&2
    return 1
  fi
  processes="$(docker top "$container" -eo pid,args)"
  if ! grep --fixed-strings 'next-server' <<<"$processes" >/dev/null; then
    echo "Next.js process is missing from the production container" >&2
    printf '%s\n' "$processes" >&2
    return 1
  fi
  if ! grep --fixed-strings -- '--import tsx job-worker.ts' <<<"$processes" >/dev/null; then
    echo "Job worker process is missing from the production container" >&2
    printf '%s\n' "$processes" >&2
    return 1
  fi
}

probe_live() {
  if ! response="$(curl --fail --silent --show-error \
      --connect-timeout 2 --max-time 5 \
      http://127.0.0.1:3000/api/live)"; then
    echo "Container liveness request failed" >&2
    return 1
  fi
  revision="$(jq -r \
    'select(.status == "ok" and .live == true) | .revision // empty' \
    <<<"$response")"
  if [[ "$revision" != "${verified_sha:0:12}" ]]; then
    echo "Container liveness revision does not match the verified image" >&2
    return 1
  fi
}

ready=false
for attempt in {1..30}; do
  if assert_runtime && probe_live; then
    ready=true
    break
  fi
  sleep 2
done
if [[ "$ready" != true ]]; then
  docker logs "$container" >&2
  echo "Container did not become live on the expected revision" >&2
  exit 1
fi

# A Worker that exits successfully during drain can otherwise hide behind a
# healthy Web process. Require both supervised children and liveness to remain
# stable across a sustained interval.
for attempt in {1..6}; do
  if ! assert_runtime || ! probe_live; then
    docker logs "$container" >&2
    echo "Container lost runtime stability during the sustained probe" >&2
    exit 1
  fi
  sleep 2
done
