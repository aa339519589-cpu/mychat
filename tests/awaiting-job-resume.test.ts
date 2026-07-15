import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  JOB_RESUME_INPUT_MAX_BYTES,
  parseResumeAwaitingJobCommand,
} from '../lib/jobs/resume-command'
import { SupabaseJobRepository } from '../lib/jobs/supabase-repository'

const migration = readFileSync(new URL(
  '../supabase/migrations/20260713230000_awaiting_job_resume.sql',
  import.meta.url,
), 'utf8')
const route = readFileSync(new URL(
  '../app/api/v1/jobs/[jobId]/resume/route.ts',
  import.meta.url,
), 'utf8')

test('awaiting checkpoints release the live lease while preserving the fence', () => {
  assert.match(migration, /jobs_awaiting_input_unleased_check/)
  assert.match(migration, /status <> 'awaiting_input'[\s\S]*lease_owner is null[\s\S]*lease_expires_at is null/)
  assert.match(migration, /lease_owner = case when input_status = 'awaiting_input' then null else lease_owner end/)
  assert.match(migration, /lease_expires_at = case when input_status = 'awaiting_input' then null else lease_expires_at end/)
  assert.match(migration, /'leaseReleased', input_status = 'awaiting_input'/)
  assert.match(migration, /old\.status = 'awaiting_input' and new\.status in \([\s\S]*'queued'[\s\S]*'cancelling'/)
  assert.doesNotMatch(migration, /old\.status = 'awaiting_input' and new\.status in \([\s\S]{0,100}'running'/)
})

test('resume RPC is owner-safe, checkpoint-CAS, idempotent, bounded, and atomic', () => {
  assert.match(migration, /create or replace function public\.resume_awaiting_job/)
  assert.match(migration, /auth\.uid\(\)/)
  assert.match(migration, /awaiting_job_resume_actor_mismatch/)
  assert.match(migration, /v_claim_role is distinct from 'service_role'[\s\S]*v_database_role is distinct from 'service_role'/)
  assert.match(migration, /octet_length\(normalized_input::text\) > 65536/)
  assert.match(migration, /from public\.jobs[\s\S]*for update/)
  assert.match(migration, /current_checkpoint\.resumable/)
  assert.match(migration, /current_checkpoint\.version <> input_expected_checkpoint_version/)
  assert.match(migration, /version = version \+ 1[\s\S]*jsonb_set\(checkpoint, '\{resumeInput\}'/)
  assert.match(migration, /where job_id = current_job\.id[\s\S]*version = input_expected_checkpoint_version[\s\S]*and resumable/)
  assert.match(migration, /status = 'queued'[\s\S]*event_sequence = event_sequence \+ 1/)
  assert.match(migration, /'job\.resumed', input_idempotency_key/)
  assert.match(migration, /set status = 'queued', error = null, finished_at = null/)
  assert.match(migration, /insert into public\.audit_log[\s\S]*'job\.resumed'/)
  assert.match(migration, /grant execute on function public\.resume_awaiting_job[\s\S]*authenticated, service_role/)
})

test('v8 readiness makes the resume state machine a production dependency', () => {
  assert.match(migration, /create or replace function public\.runtime_healthcheck_v8\(\)/)
  assert.match(migration, /select public\.runtime_healthcheck_v7\(\)/)
  assert.match(migration, /to_regprocedure\([\s\S]*resume_awaiting_job/)
  assert.match(migration, /has_function_privilege\([\s\S]*'authenticated'[\s\S]*resume_awaiting_job/)
  assert.match(migration, /conname = 'jobs_awaiting_input_unleased_check'/)
})

test('resume command accepts only a bounded object and a canonical idempotency key', () => {
  assert.deepEqual(parseResumeAwaitingJobCommand({
    expectedCheckpointVersion: 7,
    resumeInput: { answer: 'continue' },
  }, 'resume-request-0001'), {
    expectedCheckpointVersion: 7,
    idempotencyKey: 'resume-request-0001',
    resumeInput: { answer: 'continue' },
  })
  assert.throws(() => parseResumeAwaitingJobCommand({
    expectedCheckpointVersion: 0, resumeInput: {},
  }, 'resume-request-0001'))
  assert.throws(() => parseResumeAwaitingJobCommand({
    expectedCheckpointVersion: 1, resumeInput: [],
  }, 'resume-request-0001'))
  assert.throws(() => parseResumeAwaitingJobCommand({
    expectedCheckpointVersion: 1, resumeInput: {}, extra: true,
  }, 'resume-request-0001'))
  assert.throws(() => parseResumeAwaitingJobCommand({
    expectedCheckpointVersion: 1,
    resumeInput: { value: 'x'.repeat(JOB_RESUME_INPUT_MAX_BYTES) },
  }, 'resume-request-0001'))
  assert.throws(() => parseResumeAwaitingJobCommand({
    expectedCheckpointVersion: 1, resumeInput: {},
  }, 'short'))
})

test('v1 resume route is thin, authenticated, limited, and uses stable errors', () => {
  const maintenanceIndex = route.indexOf('expensiveWriteMaintenanceResponse(request)')
  const authIndex = route.indexOf('resolveAuth()')
  const rateIndex = route.indexOf('enforceRequestRateLimit(auth')
  const bodyIndex = route.indexOf('readJson<unknown>')
  const rpcIndex = route.indexOf('.resume({')
  assert.ok(maintenanceIndex >= 0 && authIndex > maintenanceIndex
    && rateIndex > authIndex && bodyIndex > rateIndex && rpcIndex > bodyIndex)
  assert.match(route, /request\.headers\.get\('Idempotency-Key'\)/)
  assert.match(route, /maxBytes: JOB_RESUME_BODY_MAX_BYTES/)
  assert.match(route, /apiErrorResponseV1/)
  assert.match(route, /code: 'CONFLICT'/)
  assert.doesNotMatch(route, /runAgentLoop|claim_next_job|checkpoint_job/)
})

test('Supabase repository sends the owner/CAS command and validates its result', async () => {
  let calledName = ''
  let calledArgs: Record<string, unknown> = {}
  const client = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      calledName = name
      calledArgs = args
      return {
        data: {
          resumed: true, replayed: false, reason: null, status: 'queued',
          checkpointVersion: 8, eventSeq: 12,
        },
        error: null,
      }
    },
  } as unknown as SupabaseClient
  const repository = new SupabaseJobRepository({
    createAdminClient: () => client,
    rpcTimeoutMs: 100,
  })
  const result = await repository.resume({
    jobId: '89800000-0000-4000-8000-000000000002',
    principalId: '00000000-0000-4000-8000-000000000001',
    expectedCheckpointVersion: 7,
    idempotencyKey: 'resume-request-0001',
    resumeInput: { answer: 'continue' },
  })
  assert.equal(calledName, 'resume_awaiting_job')
  assert.deepEqual(calledArgs, {
    input_job_id: '89800000-0000-4000-8000-000000000002',
    input_principal_id: '00000000-0000-4000-8000-000000000001',
    input_expected_checkpoint_version: 7,
    input_idempotency_key: 'resume-request-0001',
    input_resume_input: { answer: 'continue' },
  })
  assert.deepEqual(result, {
    accepted: true, replayed: false, reason: null, status: 'queued',
    checkpointVersion: 8, eventSeq: 12,
  })
})
