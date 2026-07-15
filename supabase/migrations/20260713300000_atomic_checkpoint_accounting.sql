begin;

create extension if not exists pgcrypto;

-- A checkpoint is a recovery boundary. The usage observed before that boundary
-- must become durable in the same transaction, otherwise SIGKILL can advance
-- replay state while silently losing the charge made by the abandoned attempt.
alter table public.job_checkpoints
  add column if not exists commit_key text,
  add column if not exists commit_attempt integer,
  add column if not exists commit_status text,
  add column if not exists accounting_digest text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.job_checkpoints'::regclass
      and conname = 'job_checkpoints_atomic_commit_shape_check'
  ) then
    alter table public.job_checkpoints
      add constraint job_checkpoints_atomic_commit_shape_check check (
        (commit_key is null and commit_attempt is null
          and commit_status is null and accounting_digest is null)
        or (
          length(commit_key) between 1 and 300
          and commit_key !~ '[[:cntrl:]]'
          and commit_attempt > 0
          and commit_status in ('running', 'awaiting_input')
          and accounting_digest ~ '^[0-9a-f]{64}$'
        )
      ) not valid;
  end if;
end;
$$;
alter table public.job_checkpoints
  validate constraint job_checkpoints_atomic_commit_shape_check;

-- Keep the historical signature present for the v4 structural chain, but move
-- its implementation behind an owner-only name. Any stale service client that
-- calls the legacy RPC fails deterministically instead of advancing recovery
-- state without accounting.
do $$
begin
  if to_regprocedure(
       'public.checkpoint_job_primitive(uuid,text,bigint,text,jsonb,jsonb,boolean,text)'
     ) is null then
    alter function public.checkpoint_job(
      uuid,text,bigint,text,jsonb,jsonb,boolean,text
    ) rename to checkpoint_job_primitive;
  end if;
end;
$$;

create or replace function public.checkpoint_job(
  input_job_id uuid,
  input_worker_id text,
  input_lease_version bigint,
  input_phase text,
  input_checkpoint jsonb,
  input_progress jsonb default '{}'::jsonb,
  input_resumable boolean default false,
  input_status text default 'running'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  raise exception 'legacy_checkpoint_rpc_disabled' using errcode = '55000';
end;
$$;
revoke all on function public.checkpoint_job(
  uuid,text,bigint,text,jsonb,jsonb,boolean,text
) from public, anon, authenticated, service_role;
grant execute on function public.checkpoint_job(
  uuid,text,bigint,text,jsonb,jsonb,boolean,text
) to service_role;
revoke all on function public.checkpoint_job_primitive(
  uuid,text,bigint,text,jsonb,jsonb,boolean,text
) from public, anon, authenticated, service_role;

create or replace function public.checkpoint_job_with_accounting(
  input_job_id uuid,
  input_worker_id text,
  input_lease_version bigint,
  input_attempt integer,
  input_expected_checkpoint_version bigint,
  input_checkpoint_key text,
  input_phase text,
  input_checkpoint jsonb,
  input_progress jsonb default '{}'::jsonb,
  input_resumable boolean default false,
  input_status text default 'running',
  input_ledger_entries jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_job public.jobs%rowtype;
  current_checkpoint public.job_checkpoints%rowtype;
  normalized_checkpoint jsonb := coalesce(input_checkpoint, '{}'::jsonb);
  normalized_progress jsonb := coalesce(input_progress, '{}'::jsonb);
  normalized_ledger jsonb := coalesce(input_ledger_entries, '[]'::jsonb);
  ledger_digest text;
  accounting_result jsonb;
  checkpoint_result jsonb;
  v_now timestamptz := clock_timestamp();
  expected_ledger_count integer;
  durable_ledger_count integer;
begin
  if input_job_id is null or input_worker_id is null
     or length(input_worker_id) not between 1 and 256
     or input_lease_version is null or input_lease_version < 1
     or input_attempt is null or input_attempt < 1
     or input_expected_checkpoint_version is null
     or input_expected_checkpoint_version < 0
     or input_checkpoint_key is null
     or length(input_checkpoint_key) not between 1 and 300
     or input_checkpoint_key ~ '[[:cntrl:]]'
     or input_phase is null or input_phase !~ '^[a-z][a-z0-9_.-]{0,127}$'
     or input_status not in ('running', 'awaiting_input')
     or jsonb_typeof(normalized_checkpoint) <> 'object'
     or jsonb_typeof(normalized_progress) <> 'object'
     or octet_length(normalized_checkpoint::text) > 1048576
     or octet_length(normalized_progress::text) > 786432
     or jsonb_typeof(normalized_ledger) <> 'array'
     or jsonb_array_length(normalized_ledger) > 32
     or octet_length(normalized_ledger::text) > 1048576
     or (
       select count(*) <> count(distinct entry.item->>'idempotencyKey')
       from jsonb_array_elements(normalized_ledger) as entry(item)
     ) then
    raise exception 'invalid_atomic_job_checkpoint' using errcode = '22023';
  end if;

  ledger_digest := encode(
    digest(convert_to(normalized_ledger::text, 'UTF8'), 'sha256'),
    'hex'
  );
  expected_ledger_count := jsonb_array_length(normalized_ledger);

  select * into current_job
  from public.jobs where id = input_job_id for update;
  if not found then
    return jsonb_build_object(
      'checkpointed', false, 'replayed', false, 'reason', 'not_found',
      'status', null, 'checkpointVersion', null, 'cancelRequested', false
    );
  end if;

  select * into current_checkpoint
  from public.job_checkpoints where job_id = current_job.id;

  -- An uncertain RPC response can be retried with the exact same immutable
  -- request. The latest checkpoint row is the receipt; append-only ledger rows
  -- prove that its accounting half committed as well.
  if found
     and current_checkpoint.version = input_expected_checkpoint_version + 1
     and current_checkpoint.commit_key = input_checkpoint_key then
    if current_checkpoint.commit_attempt <> input_attempt
       or current_checkpoint.commit_status <> input_status
       or current_checkpoint.accounting_digest <> ledger_digest
       or current_checkpoint.lease_version <> input_lease_version
       or current_checkpoint.phase <> input_phase
       or current_checkpoint.checkpoint <> normalized_checkpoint
       or current_checkpoint.progress <> normalized_progress
       or current_checkpoint.resumable <> coalesce(input_resumable, false) then
      raise exception 'checkpoint_idempotency_conflict' using errcode = '23505';
    end if;
    select count(*) into durable_ledger_count
    from public.ledger_entries as durable
    where durable.job_id = current_job.id
      and durable.principal_id = current_job.principal_id
      and durable.idempotency_key in (
        select entry.item->>'idempotencyKey'
        from jsonb_array_elements(normalized_ledger) as entry(item)
      );
    if durable_ledger_count <> expected_ledger_count then
      raise exception 'checkpoint_accounting_receipt_incomplete' using errcode = '23514';
    end if;
    if current_job.attempt <> input_attempt then
      return jsonb_build_object(
        'checkpointed', false, 'replayed', false, 'reason', 'stale_attempt',
        'status', current_job.status,
        'checkpointVersion', current_checkpoint.version,
        'cancelRequested', current_job.cancel_requested_at is not null
      );
    end if;
    if current_job.status in ('completed', 'failed', 'cancelled') then
      return jsonb_build_object(
        'checkpointed', false, 'replayed', false, 'reason', 'terminal',
        'status', current_job.status,
        'checkpointVersion', current_checkpoint.version,
        'cancelRequested', false
      );
    end if;
    if input_status = 'awaiting_input'
       and current_job.status = 'awaiting_input'
       and current_job.lease_owner is null
       and current_job.lease_expires_at is null
       and current_job.lease_version = input_lease_version then
      return jsonb_build_object(
        'checkpointed', true, 'replayed', true, 'reason', null,
        'status', current_job.status,
        'checkpointVersion', current_checkpoint.version,
        'cancelRequested', current_job.cancel_requested_at is not null
      );
    end if;
    if input_status <> 'running'
       or current_job.lease_owner is distinct from input_worker_id
       or current_job.lease_version <> input_lease_version
       or current_job.lease_expires_at is null
       or current_job.lease_expires_at <= v_now then
      return jsonb_build_object(
        'checkpointed', false, 'replayed', false, 'reason', 'stale_fence',
        'status', current_job.status,
        'checkpointVersion', current_checkpoint.version,
        'cancelRequested', current_job.cancel_requested_at is not null
      );
    end if;
    return jsonb_build_object(
      'checkpointed', true, 'replayed', true, 'reason', null,
      'status', current_job.status,
      'checkpointVersion', current_checkpoint.version,
      'cancelRequested', current_job.cancel_requested_at is not null
    );
  end if;

  if (found and current_checkpoint.version <> input_expected_checkpoint_version)
     or (not found and input_expected_checkpoint_version <> 0) then
    return jsonb_build_object(
      'checkpointed', false, 'replayed', false,
      'reason', 'checkpoint_version_conflict', 'status', current_job.status,
      'checkpointVersion', case when found then current_checkpoint.version else null end,
      'cancelRequested', current_job.cancel_requested_at is not null
    );
  end if;
  if current_job.attempt <> input_attempt then
    return jsonb_build_object(
      'checkpointed', false, 'replayed', false, 'reason', 'stale_attempt',
      'status', current_job.status,
      'checkpointVersion', case when found then current_checkpoint.version else null end,
      'cancelRequested', current_job.cancel_requested_at is not null
    );
  end if;
  if current_job.status in ('completed', 'failed', 'cancelled') then
    return jsonb_build_object(
      'checkpointed', false, 'replayed', false, 'reason', 'terminal',
      'status', current_job.status,
      'checkpointVersion', case when found then current_checkpoint.version else null end,
      'cancelRequested', false
    );
  end if;
  if current_job.cancel_requested_at is not null then
    return jsonb_build_object(
      'checkpointed', false, 'replayed', false, 'reason', 'cancel_requested',
      'status', current_job.status,
      'checkpointVersion', case when found then current_checkpoint.version else null end,
      'cancelRequested', true
    );
  end if;
  if current_job.lease_owner is distinct from input_worker_id
     or current_job.lease_version <> input_lease_version
     or current_job.lease_expires_at is null
     or current_job.lease_expires_at <= v_now then
    return jsonb_build_object(
      'checkpointed', false, 'replayed', false, 'reason', 'stale_fence',
      'status', current_job.status,
      'checkpointVersion', case when found then current_checkpoint.version else null end,
      'cancelRequested', current_job.cancel_requested_at is not null
    );
  end if;

  if expected_ledger_count > 0 then
    accounting_result := public.record_job_accounting(
      input_job_id, input_worker_id, input_lease_version, input_attempt,
      normalized_ledger
    );
    if accounting_result->>'recorded' <> 'true' then
      return jsonb_build_object(
        'checkpointed', false, 'replayed', false,
        'reason', 'accounting_rejected', 'status', current_job.status,
        'checkpointVersion', case when found then current_checkpoint.version else null end,
        'cancelRequested', accounting_result->'cancelRequested'
      );
    end if;
  end if;

  checkpoint_result := public.checkpoint_job_primitive(
    input_job_id, input_worker_id, input_lease_version, input_phase,
    normalized_checkpoint, normalized_progress, input_resumable, input_status
  );
  if checkpoint_result->>'checkpointed' <> 'true' then
    -- Raising, rather than returning, rolls back ledger rows if the lease crossed
    -- its deadline between the two inner operations.
    raise exception 'atomic_checkpoint_commit_failed' using errcode = '40001';
  end if;

  update public.job_checkpoints set
    commit_key = input_checkpoint_key,
    commit_attempt = input_attempt,
    commit_status = input_status,
    accounting_digest = ledger_digest
  where job_id = input_job_id
    and version = (checkpoint_result->>'checkpointVersion')::bigint;
  if not found then
    raise exception 'atomic_checkpoint_receipt_missing' using errcode = '40001';
  end if;

  return checkpoint_result || jsonb_build_object(
    'replayed', false, 'reason', null
  );
end;
$$;

revoke all on function public.checkpoint_job_with_accounting(
  uuid,text,bigint,integer,bigint,text,text,jsonb,jsonb,boolean,text,jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.checkpoint_job_with_accounting(
  uuid,text,bigint,integer,bigint,text,text,jsonb,jsonb,boolean,text,jsonb
) to service_role;

create or replace function public.runtime_healthcheck_v14()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
set statement_timeout = '1s'
as $$
  select public.runtime_healthcheck_v13()
    and to_regprocedure(
      'public.checkpoint_job_with_accounting(uuid,text,bigint,integer,bigint,text,text,jsonb,jsonb,boolean,text,jsonb)'
    ) is not null
    and has_function_privilege(
      'service_role',
      'public.checkpoint_job_with_accounting(uuid,text,bigint,integer,bigint,text,text,jsonb,jsonb,boolean,text,jsonb)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'public.checkpoint_job_with_accounting(uuid,text,bigint,integer,bigint,text,text,jsonb,jsonb,boolean,text,jsonb)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'public.checkpoint_job_with_accounting(uuid,text,bigint,integer,bigint,text,text,jsonb,jsonb,boolean,text,jsonb)',
      'EXECUTE'
    )
    and to_regprocedure(
      'public.checkpoint_job_primitive(uuid,text,bigint,text,jsonb,jsonb,boolean,text)'
    ) is not null
    and not has_function_privilege(
      'service_role',
      'public.checkpoint_job_primitive(uuid,text,bigint,text,jsonb,jsonb,boolean,text)',
      'EXECUTE'
    )
    and pg_get_functiondef(to_regprocedure(
      'public.checkpoint_job(uuid,text,bigint,text,jsonb,jsonb,boolean,text)'
    )) like '%legacy_checkpoint_rpc_disabled%'
    and not exists (
      select 1 from (values
        ('commit_key'), ('commit_attempt'), ('commit_status'), ('accounting_digest')
      ) as required_column(column_name)
      where not exists (
        select 1 from information_schema.columns as installed_column
        where table_schema = 'public'
          and table_name = 'job_checkpoints'
          and installed_column.column_name = required_column.column_name
      )
    )
    and exists (
      select 1 from pg_constraint
      where conrelid = 'public.job_checkpoints'::regclass
        and conname = 'job_checkpoints_atomic_commit_shape_check'
        and contype = 'c' and convalidated
    );
$$;
revoke all on function public.runtime_healthcheck_v14()
  from public, anon, authenticated, service_role;
grant execute on function public.runtime_healthcheck_v14() to service_role;

commit;
