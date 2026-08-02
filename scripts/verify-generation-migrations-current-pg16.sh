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
"\${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20260802190000_schema_contract_attestation_v5.sql" >/dev/null`

const first = source.indexOf(marker)
if (first < 0 || source.indexOf(marker, first + marker.length) >= 0) {
  throw new Error('current schema contract replay marker is missing or ambiguous')
}
writeFileSync(targetPath, source.replace(marker, currentContractReplay), { mode: 0o700 })
NODE

bash "$TARGET"
