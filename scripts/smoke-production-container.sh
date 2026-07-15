#!/usr/bin/env bash
set -euo pipefail

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

container="mychat-smoke-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}-${RANDOM}"
cleanup() { docker rm --force "$container" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker run --detach --name "$container" \
  --publish 127.0.0.1:3000:3000 \
  --env E2B_API_KEY=ci-container-smoke \
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
  if ! grep --fixed-strings 'node_modules/next/dist/bin/next start' <<<"$processes" >/dev/null; then
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
