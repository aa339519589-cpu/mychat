import manifest from '@/supabase/migrations.manifest.json'

if (!Number.isSafeInteger(manifest.contractVersion) || manifest.contractVersion < 1) {
  throw new Error('Invalid migration contract version')
}
if (!Number.isSafeInteger(manifest.migrationCount) || manifest.migrationCount < 1) {
  throw new Error('Invalid migration contract count')
}
if (!/^[0-9a-f]{64}$/.test(manifest.contractDigest)) {
  throw new Error('Invalid migration contract digest')
}

export const MIGRATION_CONTRACT = Object.freeze({
  version: manifest.contractVersion,
  migrationCount: manifest.migrationCount,
  digest: manifest.contractDigest,
})
