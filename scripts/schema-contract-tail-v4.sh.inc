V3_CONTRACT_VERSION=3
V3_CONTRACT_DIGEST='469579b5140dfe314e118405847128c6d7288fa605238275f48b568372d444f5'
V3_CONTRACT_MIGRATION_COUNT=47
"${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20260729020000_schema_contract_attestation_v3.sql" >/dev/null
"${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20260729020000_schema_contract_attestation_v3.sql" >/dev/null

SCHEMA_CONTRACT_RESULT="$("${PSQL[@]}" -qAt -d "$DB" -c \
  "set role service_role; select public.verify_schema_contract_v3(${V3_CONTRACT_VERSION}, '${V3_CONTRACT_DIGEST}', ${V3_CONTRACT_MIGRATION_COUNT})")"
if [[ "$SCHEMA_CONTRACT_RESULT" != "t" ]]; then
  echo "Exact historical v3 schema contract attestation was not accepted" >&2
  exit 1
fi
for mismatch in \
  "$((V3_CONTRACT_VERSION + 1)) '${V3_CONTRACT_DIGEST}' ${V3_CONTRACT_MIGRATION_COUNT}" \
  "${V3_CONTRACT_VERSION} '$(printf '0%.0s' {1..64})' ${V3_CONTRACT_MIGRATION_COUNT}" \
  "${V3_CONTRACT_VERSION} '${V3_CONTRACT_DIGEST}' $((V3_CONTRACT_MIGRATION_COUNT + 1))"; do
  read -r version digest count <<<"$mismatch"
  result="$("${PSQL[@]}" -qAt -d "$DB" -c \
    "set role service_role; select public.verify_schema_contract_v3(${version}, ${digest}, ${count})")"
  if [[ "$result" != "f" ]]; then
    echo "Mismatched historical v3 schema contract was accepted: $mismatch" >&2
    exit 1
  fi
done
SCHEMA_CONTRACT_ROWS="$("${PSQL[@]}" -qAt -d "$DB" -c \
  "select count(*) from public.schema_contract_attestations")"
if [[ "$SCHEMA_CONTRACT_ROWS" != "3" ]]; then
  echo "Schema contract v3 replay created unexpected attestation rows" >&2
  exit 1
fi
for role in anon authenticated; do
  if "${PSQL[@]}" -qAt -d "$DB" -c \
    "set role ${role}; select public.verify_schema_contract_v3(${V3_CONTRACT_VERSION}, '${V3_CONTRACT_DIGEST}', ${V3_CONTRACT_MIGRATION_COUNT})" \
    >/dev/null 2>&1; then
    echo "$role can execute the service-only v3 schema contract RPC" >&2
    exit 1
  fi
done

# Install the lifetime medium-model trial ledger, then seal and replay the exact
# current schema contract. Historical v3 remains independently verifiable.
"${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20260801010000_medium_model_trial_quota.sql" >/dev/null
"${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20260801020000_schema_contract_attestation_v4.sql" >/dev/null
"${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20260801020000_schema_contract_attestation_v4.sql" >/dev/null

CONTRACT_VERSION="$(node -e \
  "process.stdout.write(String(require(process.argv[1]).contractVersion))" \
  "$ROOT/supabase/migrations.manifest.json")"
CONTRACT_DIGEST="$(node -e \
  "process.stdout.write(require(process.argv[1]).contractDigest)" \
  "$ROOT/supabase/migrations.manifest.json")"
CONTRACT_MIGRATION_COUNT="$(node -e \
  "process.stdout.write(String(require(process.argv[1]).migrationCount))" \
  "$ROOT/supabase/migrations.manifest.json")"

SCHEMA_CONTRACT_RESULT="$("${PSQL[@]}" -qAt -d "$DB" -c \
  "set role service_role; select public.verify_schema_contract_v4(${CONTRACT_VERSION}, '${CONTRACT_DIGEST}', ${CONTRACT_MIGRATION_COUNT})")"
if [[ "$SCHEMA_CONTRACT_RESULT" != "t" ]]; then
  echo "Exact current v4 schema contract attestation was not accepted" >&2
  exit 1
fi
for mismatch in \
  "$((CONTRACT_VERSION + 1)) '${CONTRACT_DIGEST}' ${CONTRACT_MIGRATION_COUNT}" \
  "${CONTRACT_VERSION} '$(printf '0%.0s' {1..64})' ${CONTRACT_MIGRATION_COUNT}" \
  "${CONTRACT_VERSION} '${CONTRACT_DIGEST}' $((CONTRACT_MIGRATION_COUNT + 1))"; do
  read -r version digest count <<<"$mismatch"
  result="$("${PSQL[@]}" -qAt -d "$DB" -c \
    "set role service_role; select public.verify_schema_contract_v4(${version}, ${digest}, ${count})")"
  if [[ "$result" != "f" ]]; then
    echo "Mismatched current v4 schema contract was accepted: $mismatch" >&2
    exit 1
  fi
done
SCHEMA_CONTRACT_ROWS="$("${PSQL[@]}" -qAt -d "$DB" -c \
  "select count(*) from public.schema_contract_attestations")"
if [[ "$SCHEMA_CONTRACT_ROWS" != "4" ]]; then
  echo "Schema contract v4 replay created unexpected attestation rows" >&2
  exit 1
fi
for role in anon authenticated; do
  if "${PSQL[@]}" -qAt -d "$DB" -c \
    "set role ${role}; select public.verify_schema_contract_v4(${CONTRACT_VERSION}, '${CONTRACT_DIGEST}', ${CONTRACT_MIGRATION_COUNT})" \
    >/dev/null 2>&1; then
    echo "$role can execute the service-only v4 schema contract RPC" >&2
    exit 1
  fi
done
