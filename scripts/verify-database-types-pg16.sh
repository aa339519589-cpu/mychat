#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DB="mychat_database_types_test"
PSQL=(psql -X -v ON_ERROR_STOP=1)
MODE="${1:---check}"

if [[ "$MODE" != "--check" && "$MODE" != "--write" ]]; then
  echo "Usage: bash scripts/verify-database-types-pg16.sh [--check|--write]" >&2
  exit 2
fi

cleanup() {
  "${PSQL[@]}" -d postgres >/dev/null 2>&1 <<SQL || true
select pg_terminate_backend(pid) from pg_stat_activity where datname = '${DB}';
drop database if exists ${DB};
SQL
}
trap cleanup EXIT

if [[ "$("${PSQL[@]}" -qAt -d postgres -c \
  "select exists(select 1 from pg_available_extensions where name = 'vector')")" != "t" ]]; then
  echo "PostgreSQL 16 pgvector extension is required for canonical schema replay" >&2
  exit 1
fi

"${PSQL[@]}" -d postgres <<SQL
do \$\$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  else
    alter role service_role bypassrls;
  end if;
end;
\$\$;
select pg_terminate_backend(pid) from pg_stat_activity where datname = '${DB}';
drop database if exists ${DB};
create database ${DB};
SQL

"${PSQL[@]}" -d "$DB" <<'SQL'
create extension if not exists pgcrypto;
create schema auth;
create schema storage;

create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
create function storage.foldername(input_name text) returns text[] language sql immutable as $$
  select string_to_array(input_name, '/')
$$;

create table auth.users (id uuid primary key);
create table storage.buckets (
  id text primary key,
  name text not null,
  public boolean not null default false,
  file_size_limit bigint,
  allowed_mime_types text[]
);
create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text not null references storage.buckets(id),
  name text not null,
  owner_id text,
  metadata jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(bucket_id, name)
);
alter table storage.objects enable row level security;
grant usage on schema public, auth, storage to anon, authenticated, service_role;
grant select, insert, update, delete on all tables in schema storage to service_role;
SQL

"${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/schema.sql" >/dev/null
"${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/agent-tasks.sql" >/dev/null
"${PSQL[@]}" -d "$DB" \
  -f "$ROOT/supabase/baseline/20260623_legacy_compatibility.sql" >/dev/null

while IFS= read -r migration; do
  [[ -n "$migration" ]] || continue
  "${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/$migration" >/dev/null
done < <(node -e '
  const manifest = require(process.argv[1])
  for (const entry of manifest.migrations) console.log(typeof entry === "string" ? entry : entry.file)
' "$ROOT/supabase/migrations.manifest.json")

"${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20260717020000_schema_contract_attestation_v2.sql" >/dev/null
node "$ROOT/scripts/generate-database-types.mjs" --database "$DB" "$MODE"

echo "Canonical PostgreSQL database type verification passed"
