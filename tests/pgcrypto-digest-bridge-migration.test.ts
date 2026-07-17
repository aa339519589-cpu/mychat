import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const bridge = readFileSync(new URL(
  '../supabase/migrations/20260713285000_pgcrypto_digest_bridge.sql',
  import.meta.url,
), 'utf8')
const billing = readFileSync(new URL(
  '../supabase/migrations/20260713290000_billing_reconciliation_contract.sql',
  import.meta.url,
), 'utf8')
const pg16 = readFileSync(new URL(
  '../scripts/verify-generation-migrations-pg16.sh',
  import.meta.url,
), 'utf8')

test('pgcrypto digest bridge is ordered before billing and remains service-only', () => {
  assert.match(bridge, /to_regprocedure\('public\.digest\(bytea,text\)'\) is null/)
  assert.match(bridge, /select extensions\.digest\(input, algorithm\)/)
  assert.match(bridge, /set search_path = pg_catalog, extensions, pg_temp/)
  assert.match(bridge, /revoke all on function public\.digest\(bytea,text\)[\s\S]*from public, anon, authenticated/)
  assert.match(bridge, /grant execute on function public\.digest\(bytea,text\)[\s\S]*to service_role/)
  assert.match(billing, /digest\(convert_to\(input_quote::text, 'UTF8'\), 'sha256'\)/)
  assert.match(pg16, /alter extension pgcrypto set schema extensions/)
  assert.ok(
    pg16.indexOf('20260713285000_pgcrypto_digest_bridge.sql')
      < pg16.indexOf('20260713290000_billing_reconciliation_contract.sql'),
  )
  assert.match(pg16, /has_function_privilege\('authenticated','public\.digest\(bytea,text\)','execute'\)/)
})
