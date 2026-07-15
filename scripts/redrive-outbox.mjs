import { pathToFileURL } from 'node:url'
import { createClient } from '@supabase/supabase-js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,199}$/

function optionMap(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!name?.startsWith('--') || value === undefined || value.startsWith('--') || values.has(name)) {
      throw new Error('Invalid outbox redrive arguments')
    }
    values.set(name, value)
  }
  return values
}

export function parseOutboxRedriveArguments(argv) {
  const values = optionMap(argv)
  const allowed = new Set(['--id', '--lock-version', '--key', '--actor', '--reason', '--delay'])
  if ([...values.keys()].some(name => !allowed.has(name))) {
    throw new Error('Unknown outbox redrive option')
  }
  const id = values.get('--id') ?? ''
  const lockVersion = Number(values.get('--lock-version'))
  const key = values.get('--key') ?? ''
  const actor = values.get('--actor') ?? ''
  const reason = values.get('--reason') ?? ''
  const delaySeconds = Number(values.get('--delay') ?? '0')
  if (!UUID.test(id) || !Number.isSafeInteger(lockVersion) || lockVersion < 0
    || !KEY.test(key) || actor.length < 1 || actor.length > 256 || /[\u0000-\u001f\u007f]/.test(actor)
    || reason.length < 1 || reason.length > 1_024 || /[\u0000-\u001f\u007f]/.test(reason)
    || !Number.isSafeInteger(delaySeconds) || delaySeconds < 0 || delaySeconds > 86_400) {
    throw new Error('Invalid outbox redrive arguments')
  }
  return { id, lockVersion, key, actor, reason, delaySeconds }
}

function productionSupabaseUrl(environment) {
  const raw = environment.SUPABASE_URL?.trim()
    || environment.NEXT_PUBLIC_SUPABASE_URL?.trim()
    || ''
  const url = new URL(raw)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('A safe HTTPS Supabase URL is required')
  }
  return url.origin
}

export async function redriveOutbox(argv, environment = process.env) {
  const input = parseOutboxRedriveArguments(argv)
  const serviceKey = environment.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? ''
  if (serviceKey.length < 20) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required')
  const client = createClient(productionSupabaseUrl(environment), serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { data, error } = await client.rpc('redrive_job_outbox', {
    input_outbox_id: input.id,
    input_expected_lock_version: input.lockVersion,
    input_redrive_key: input.key,
    input_actor_id: input.actor,
    input_reason: input.reason,
    input_delay_seconds: input.delaySeconds,
  })
  if (error) throw new Error(`Outbox redrive RPC failed (${error.code ?? 'unknown'})`)
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Outbox redrive returned malformed data')
  }
  return data
}

async function main() {
  const result = await redriveOutbox(process.argv.slice(2))
  process.stdout.write(`${JSON.stringify(result)}\n`)
  if (result.redriven !== true) process.exitCode = 2
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}

