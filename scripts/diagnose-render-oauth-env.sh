#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${RENDER_API_KEY:-}" ]] || [[ ! "${RENDER_SERVICE_ID:-}" =~ ^srv-[a-z0-9]+$ ]]; then
  echo 'render_release_credentials=missing'
  exit 1
fi

get_env() {
  local key="$1" response code body
  response="$(curl --silent --show-error --connect-timeout 10 --max-time 60 \
    --header "Authorization: Bearer $RENDER_API_KEY" \
    --header 'Content-Type: application/json' \
    --write-out $'\n%{http_code}' \
    "https://api.render.com/v1/services/$RENDER_SERVICE_ID/env-vars/$key")"
  code="${response##*$'\n'}"
  body="${response%$'\n'*}"
  case "$code" in
    200) jq -r '.value // ""' <<<"$body" ;;
    404) printf '' ;;
    *) echo "render_env_lookup_${key}=http_${code}" >&2; exit 1 ;;
  esac
}

state() {
  if [[ -n "${1:-}" ]]; then printf 'present'; else printf 'missing'; fi
}

client_id="$(get_env GITHUB_CLIENT_ID)"
client_secret="$(get_env GITHUB_CLIENT_SECRET)"
agent_key="$(get_env AGENT_CREDENTIAL_KEY)"
legacy_id="$(get_env GITHUB_OAUTH_CLIENT_ID)"
legacy_secret="$(get_env GITHUB_OAUTH_CLIENT_SECRET)"

echo "render_github_client_id=$(state "$client_id")"
echo "render_github_client_secret=$(state "$client_secret")"
echo "render_agent_credential_key=$(state "$agent_key")"
echo "render_legacy_oauth_client_id=$(state "$legacy_id")"
echo "render_legacy_oauth_client_secret=$(state "$legacy_secret")"
echo "repository_github_client_id_backup=$(state "${REPO_GITHUB_CLIENT_ID:-}")"
echo "repository_github_client_secret_backup=$(state "${REPO_GITHUB_CLIENT_SECRET:-}")"
echo "repository_agent_credential_key_backup=$(state "${REPO_AGENT_CREDENTIAL_KEY:-}")"

resolved_id="${client_id:-${legacy_id:-${REPO_GITHUB_CLIENT_ID:-}}}"
resolved_secret="${client_secret:-${legacy_secret:-${REPO_GITHUB_CLIENT_SECRET:-}}}"
if [[ -z "$resolved_id" || -z "$resolved_secret" ]]; then
  echo 'oauth_repair_source=incomplete'
  exit 42
fi

echo 'oauth_repair_source=complete'
