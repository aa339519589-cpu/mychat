-- Controlled dead-letter replay. A redrive starts a new bounded delivery
-- round, advances the generation fence, and commits an immutable audit record
-- in the same transaction. Direct service-role table writes remain forbidden.
begin;

alter table public.job_outbox
  add column if not exists replay_count integer not null default 0,
  add column if not exists max_redrives integer not null default 3,
  add column if not exists last_redrive_key text,
  add column if not exists last_redrive_actor_id text,
  add column if not exists last_redrive_from_lock_version bigint,
  add column if not exists last_redriven_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.job_outbox'::regclass
      and conname = 'job_outbox_redrive_bounds_check'
  ) then
    alter table public.job_outbox add constraint job_outbox_redrive_bounds_check
      check (
        replay_count between 0 and 100
        and max_redrives between 0 and 100
        and replay_count <= max_redrives
      );
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.job_outbox'::regclass
      and conname = 'job_outbox_redrive_identity_check'
  ) then
    alter table public.job_outbox add constraint job_outbox_redrive_identity_check
      check (
        (
          last_redrive_key is null
          and last_redrive_actor_id is null
          and last_redrive_from_lock_version is null
          and last_redriven_at is null
        ) or (
          last_redrive_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,199}$'
          and length(last_redrive_actor_id) between 1 and 256
          and last_redrive_actor_id !~ '[[:cntrl:]]'
          and last_redrive_from_lock_version >= 0
          and last_redriven_at is not null
        )
      );
  end if;
end;
$$;

create unique index if not exists audit_log_job_outbox_redrive_request_unique
  on public.audit_log(resource_id, request_id)
  where resource_type = 'job_outbox'
    and action = 'outbox.redriven'
    and request_id is not null;

create or replace function public.redrive_job_outbox(
  input_outbox_id uuid,
  input_expected_lock_version bigint,
  input_redrive_key text,
  input_actor_id text,
  input_reason text,
  input_delay_seconds integer default 0
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_message public.job_outbox%rowtype;
  prior_redrive public.audit_log%rowtype;
  previous_attempts integer;
  previous_error text;
  v_now timestamptz := clock_timestamp();
begin
  if input_outbox_id is null
     or input_expected_lock_version is null or input_expected_lock_version < 0
     or input_redrive_key is null
     or input_redrive_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,199}$'
     or input_actor_id is null or length(input_actor_id) not between 1 and 256
     or input_actor_id ~ '[[:cntrl:]]'
     or input_reason is null or length(input_reason) not between 1 and 1024
     or input_reason ~ '[[:cntrl:]]'
     or input_delay_seconds is null or input_delay_seconds not between 0 and 86400 then
    raise exception 'invalid_job_outbox_redrive' using errcode = '22023';
  end if;

  -- The append-only audit entry is also the durable idempotency receipt. It
  -- preserves the original response even after later redrive rounds.
  select * into prior_redrive
  from public.audit_log
  where resource_type = 'job_outbox'
    and resource_id = input_outbox_id::text
    and action = 'outbox.redriven'
    and request_id = input_redrive_key;

  if found then
    if prior_redrive.actor_id = input_actor_id
       and (prior_redrive.metadata->>'sourceLockVersion')::bigint
         = input_expected_lock_version
       and prior_redrive.metadata->>'reason' = input_reason
       and (prior_redrive.metadata->>'delaySeconds')::integer
         = input_delay_seconds then
      return jsonb_build_object(
        'redriven', true, 'replayed', true, 'reason', null,
        'status', 'pending',
        'lockVersion', prior_redrive.metadata->'lockVersion',
        'replayCount', prior_redrive.metadata->'replayCount',
        'maxRedrives', prior_redrive.metadata->'maxRedrives',
        'availableAt', prior_redrive.metadata->'availableAt'
      );
    end if;
    return jsonb_build_object(
      'redriven', false, 'replayed', false, 'reason', 'idempotency_conflict'
    );
  end if;

  select * into current_message
  from public.job_outbox
  where id = input_outbox_id
  for update;

  if not found then
    return jsonb_build_object('redriven', false, 'replayed', false, 'reason', 'not_found');
  end if;

  -- A response lost after commit can be retried with the same request key.
  -- Bind the key to its actor and source generation to reject key reuse.
  if current_message.last_redrive_key = input_redrive_key then
    if current_message.last_redrive_actor_id = input_actor_id
       and current_message.last_redrive_from_lock_version = input_expected_lock_version then
      return jsonb_build_object(
        'redriven', true, 'replayed', true, 'reason', null,
        'status', current_message.status,
        'lockVersion', current_message.lock_version,
        'replayCount', current_message.replay_count,
        'maxRedrives', current_message.max_redrives,
        'availableAt', current_message.available_at
      );
    end if;
    return jsonb_build_object(
      'redriven', false, 'replayed', false, 'reason', 'idempotency_conflict'
    );
  end if;

  if current_message.lock_version <> input_expected_lock_version then
    return jsonb_build_object('redriven', false, 'replayed', false, 'reason', 'stale_lock');
  end if;
  if current_message.status <> 'dead' then
    return jsonb_build_object('redriven', false, 'replayed', false, 'reason', 'not_dead');
  end if;
  if current_message.replay_count >= current_message.max_redrives then
    return jsonb_build_object(
      'redriven', false, 'replayed', false, 'reason', 'redrive_limit',
      'replayCount', current_message.replay_count,
      'maxRedrives', current_message.max_redrives
    );
  end if;

  previous_attempts := current_message.attempts;
  previous_error := current_message.last_error;

  update public.job_outbox
  set status = 'pending',
      attempts = 0,
      available_at = v_now + make_interval(secs => input_delay_seconds),
      locked_by = null,
      lock_expires_at = null,
      published_at = null,
      last_error = null,
      lock_version = lock_version + 1,
      replay_count = replay_count + 1,
      last_redrive_key = input_redrive_key,
      last_redrive_actor_id = input_actor_id,
      last_redrive_from_lock_version = input_expected_lock_version,
      last_redriven_at = v_now,
      updated_at = v_now
  where id = current_message.id
    and status = 'dead'
    and lock_version = input_expected_lock_version
    and replay_count < max_redrives
  returning * into current_message;

  if not found then
    return jsonb_build_object(
      'redriven', false, 'replayed', false, 'reason', 'concurrent_change'
    );
  end if;

  insert into public.audit_log(
    principal_id, actor_type, actor_id, action, resource_type, resource_id,
    job_id, request_id, metadata, created_at
  ) values (
    current_message.principal_id, 'service', input_actor_id,
    'outbox.redriven', 'job_outbox', current_message.id::text,
    current_message.job_id, input_redrive_key,
    jsonb_build_object(
      'topic', current_message.topic,
      'reason', input_reason,
      'delaySeconds', input_delay_seconds,
      'sourceLockVersion', input_expected_lock_version,
      'lockVersion', current_message.lock_version,
      'replayCount', current_message.replay_count,
      'maxRedrives', current_message.max_redrives,
      'previousAttempts', previous_attempts,
      'previousError', previous_error,
      'availableAt', current_message.available_at
    ),
    v_now
  );

  return jsonb_build_object(
    'redriven', true, 'replayed', false, 'reason', null,
    'status', current_message.status,
    'lockVersion', current_message.lock_version,
    'replayCount', current_message.replay_count,
    'maxRedrives', current_message.max_redrives,
    'availableAt', current_message.available_at
  );
end;
$$;

revoke all on function public.redrive_job_outbox(uuid,bigint,text,text,text,integer)
  from public, anon, authenticated, service_role;
grant execute on function public.redrive_job_outbox(uuid,bigint,text,text,text,integer)
  to service_role;

commit;
