#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE="$ROOT/scripts/verify-generation-migrations-pg16.sh"
TARGET="$ROOT/scripts/.verify-generation-migrations-current-pg16.sh"

cleanup() {
  rm -f "$TARGET"
}
trap cleanup EXIT

node - "$SOURCE" "$TARGET" <<'NODE'
const { readFileSync, writeFileSync } = require('node:fs')

const [sourcePath, targetPath] = process.argv.slice(2)
const source = readFileSync(sourcePath, 'utf8')
const marker = `"\${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20260801020000_schema_contract_attestation_v4.sql" >/dev/null
"\${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20260801020000_schema_contract_attestation_v4.sql" >/dev/null`
const currentContractReplay = `${marker}
"\${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20260802181500_fix_service_role_claim_context.sql" >/dev/null
"\${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20260802181500_fix_service_role_claim_context.sql" >/dev/null
"\${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20260802190000_schema_contract_attestation_v5.sql" >/dev/null
"\${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20260802190000_schema_contract_attestation_v5.sql" >/dev/null
"\${PSQL[@]}" -d "$DB" <<'SQL'
create table if not exists public.memories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  content text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.memories enable row level security;
alter table public.profiles
  add column if not exists memory_enabled boolean not null default true;
SQL
"\${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20261003010000_memory_topics.sql" >/dev/null
"\${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20261003010000_memory_topics.sql" >/dev/null
"\${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20261003020000_schema_contract_attestation_v6.sql" >/dev/null
"\${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20261003020000_schema_contract_attestation_v6.sql" >/dev/null
"\${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20261003030000_memory_sensitivity_and_reset.sql" >/dev/null
"\${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20261003030000_memory_sensitivity_and_reset.sql" >/dev/null
"\${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20261003040000_schema_contract_attestation_v7.sql" >/dev/null
"\${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20261003040000_schema_contract_attestation_v7.sql" >/dev/null
"\${PSQL[@]}" -d "$DB" -f "$ROOT/tests/memory-controls-pg16.sql" >/dev/null
"\${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20261003050000_conversation_memory_control.sql" >/dev/null
"\${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20261003050000_conversation_memory_control.sql" >/dev/null
"\${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20261003060000_schema_contract_attestation_v8.sql" >/dev/null
"\${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20261003060000_schema_contract_attestation_v8.sql" >/dev/null
"\${PSQL[@]}" -d "$DB" -f "$ROOT/tests/conversation-memory-control-pg16.sql" >/dev/null
"\${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20261003070000_remote_mcp_connectors.sql" >/dev/null
"\${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20261003070000_remote_mcp_connectors.sql" >/dev/null
"\${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20261003080000_schema_contract_attestation_v9.sql" >/dev/null
"\${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20261003080000_schema_contract_attestation_v9.sql" >/dev/null
"\${PSQL[@]}" -d "$DB" -f "$ROOT/tests/mcp-connector-storage-pg16.sql" >/dev/null
"\${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20261003090000_connector_oauth_lifecycle.sql" >/dev/null
"\${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20261003090000_connector_oauth_lifecycle.sql" >/dev/null
"\${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20261003100000_schema_contract_attestation_v10.sql" >/dev/null
"\${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20261003100000_schema_contract_attestation_v10.sql" >/dev/null
"\${PSQL[@]}" -d "$DB" -f "$ROOT/tests/connector-oauth-storage-pg16.sql" >/dev/null
"\${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20261003110000_private_chat_and_memory_claims.sql" >/dev/null
"\${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20261003110000_private_chat_and_memory_claims.sql" >/dev/null
"\${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20261003120000_schema_contract_attestation_v11.sql" >/dev/null
"\${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20261003120000_schema_contract_attestation_v11.sql" >/dev/null
"\${PSQL[@]}" -d "$DB" -f "$ROOT/tests/private-chat-pg16.sql" >/dev/null`

const first = source.indexOf(marker)
if (first < 0 || source.indexOf(marker, first + marker.length) >= 0) {
  throw new Error('current schema contract replay marker is missing or ambiguous')
}
writeFileSync(targetPath, source.replace(marker, currentContractReplay), { mode: 0o700 })
NODE

bash "$TARGET"
