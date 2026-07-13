-- Unified job control plane. All expensive work is enqueued here and every
-- worker mutation is fenced by (lease_owner, lease_version, lease expiry).
-- The tables are systems of record; browser roles receive read-only projections
-- and service-role callers can mutate state only through SECURITY DEFINER RPCs.
begin;

create table if not exists public.jobs (
  id uuid primary key,
  type text not null,
  queue text not null,
  principal_id uuid not null references auth.users(id) on delete restrict,
  auth_class text not null default 'registered'
    check (auth_class in ('anonymous', 'registered', 'service')),
  subject jsonb not null default '{}'::jsonb,
  idempotency_key text not null,
  input_hash text not null,
  payload jsonb not null default '{}'::jsonb,
  budget jsonb not null default '{}'::jsonb,
  status text not null default 'queued' check (status in (
    'queued', 'leased', 'running', 'awaiting_input', 'cancelling',
    'completed', 'failed', 'cancelled'
  )),
  attempt integer not null default 0 check (attempt >= 0),
  max_attempts integer not null default 3 check (max_attempts between 1 and 100),
  priority integer not null default 0 check (priority between -1000 and 1000),
  available_at timestamptz not null default now(),
  lease_owner text,
  lease_version bigint not null default 0 check (lease_version >= 0),
  lease_expires_at timestamptz,
  cancel_requested_at timestamptz,
  cancel_reason text,
  progress jsonb not null default '{}'::jsonb,
  result jsonb,
  error_class text check (
    error_class is null or error_class in ('retryable', 'user', 'provider', 'policy', 'internal')
  ),
  error_code text,
  event_sequence bigint not null default 0 check (event_sequence >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  terminal_at timestamptz,
  constraint jobs_type_format_check
    check (type ~ '^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)+$'),
  constraint jobs_queue_format_check
    check (queue ~ '^[a-z][a-z0-9_.-]{0,63}$'),
  constraint jobs_idempotency_key_check
    check (length(idempotency_key) between 1 and 256),
  constraint jobs_input_hash_check
    check (length(input_hash) between 16 and 256),
  constraint jobs_json_shape_check check (
    jsonb_typeof(subject) = 'object'
    and jsonb_typeof(payload) = 'object'
    and jsonb_typeof(budget) = 'object'
    and jsonb_typeof(progress) = 'object'
  ),
  constraint jobs_json_size_check check (
    octet_length(subject::text) <= 262144
    and octet_length(payload::text) <= 1048576
    and octet_length(budget::text) <= 262144
    and octet_length(progress::text) <= 1048576
    and (result is null or octet_length(result::text) <= 1048576)
  ),
  constraint jobs_lease_shape_check check (
    (lease_owner is null) = (lease_expires_at is null)
    and (lease_owner is null or length(lease_owner) between 1 and 256)
  ),
  constraint jobs_terminal_shape_check check (
    (
      status in ('completed', 'failed', 'cancelled')
      and terminal_at is not null
      and lease_owner is null
      and lease_expires_at is null
    ) or (
      status not in ('completed', 'failed', 'cancelled')
      and terminal_at is null
    )
  ),
  constraint jobs_queued_unleased_check check (
    status <> 'queued' or (lease_owner is null and lease_expires_at is null)
  ),
  constraint jobs_failed_error_check check (
    status <> 'failed' or (error_class is not null and error_code is not null)
  )
);

create unique index if not exists jobs_principal_idempotency_key_idx
  on public.jobs(principal_id, idempotency_key);
create index if not exists jobs_queue_ready_idx
  on public.jobs(queue, priority desc, available_at, created_at)
  where status = 'queued';
create index if not exists jobs_expired_lease_idx
  on public.jobs(lease_expires_at, queue)
  where status in ('leased', 'running', 'cancelling');
create index if not exists jobs_principal_status_created_idx
  on public.jobs(principal_id, status, created_at desc);
create unique index if not exists jobs_one_active_chat_conversation_idx
  on public.jobs(principal_id, ((subject->>'conversationId')))
  where type = 'chat.generation'
    and status in ('queued', 'leased', 'running', 'awaiting_input', 'cancelling');
create unique index if not exists jobs_one_active_chat_title_idx
  on public.jobs(principal_id, ((subject->>'conversationId')))
  where type = 'chat.title'
    and status in ('queued', 'leased', 'running', 'awaiting_input', 'cancelling');
create unique index if not exists jobs_one_active_agent_task_idx
  on public.jobs(principal_id, ((subject->>'taskId')))
  where type = 'agent.task'
    and status in ('queued', 'leased', 'running', 'awaiting_input', 'cancelling');

create table if not exists public.job_events (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  principal_id uuid not null,
  seq bigint not null check (seq > 0),
  kind text not null check (kind ~ '^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)+$'),
  idempotency_key text check (
    idempotency_key is null or length(idempotency_key) between 1 and 256
  ),
  schema_version integer not null default 1 check (schema_version between 1 and 1000),
  payload jsonb not null default '{}'::jsonb,
  worker_id text,
  lease_version bigint,
  created_at timestamptz not null default now(),
  constraint job_events_payload_check check (
    jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 1048576
  ),
  constraint job_events_fence_shape_check check (
    (worker_id is null and lease_version is null)
    or (worker_id is not null and lease_version is not null and lease_version > 0)
  ),
  unique (job_id, seq)
);

create index if not exists job_events_principal_job_seq_idx
  on public.job_events(principal_id, job_id, seq);
create index if not exists job_events_created_idx
  on public.job_events(created_at);
create unique index if not exists job_events_idempotency_idx
  on public.job_events(job_id, idempotency_key)
  where idempotency_key is not null;

create table if not exists public.job_checkpoints (
  job_id uuid primary key references public.jobs(id) on delete cascade,
  principal_id uuid not null,
  version bigint not null default 1 check (version > 0),
  phase text not null check (phase ~ '^[a-z][a-z0-9_.-]{0,127}$'),
  checkpoint jsonb not null default '{}'::jsonb,
  progress jsonb not null default '{}'::jsonb,
  resumable boolean not null default false,
  lease_version bigint not null check (lease_version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint job_checkpoints_json_check check (
    jsonb_typeof(checkpoint) = 'object'
    and jsonb_typeof(progress) = 'object'
    and octet_length(checkpoint::text) <= 1048576
    and octet_length(progress::text) <= 1048576
  )
);

create index if not exists job_checkpoints_resumable_idx
  on public.job_checkpoints(updated_at)
  where resumable;

create table if not exists public.job_tool_effects (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete restrict,
  principal_id uuid not null,
  tool_call_id text not null,
  tool_name text not null,
  args_hash text not null,
  effect_key text not null,
  status text not null default 'reserved' check (status in (
    'reserved', 'running', 'succeeded', 'failed', 'compensated', 'unknown'
  )),
  replay_safe boolean not null default false,
  result_ref jsonb,
  metadata jsonb not null default '{}'::jsonb,
  lease_version bigint not null check (lease_version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint job_tool_effects_strings_check check (
    length(tool_call_id) between 1 and 200
    and length(tool_name) between 1 and 200
    and length(args_hash) between 16 and 200
    and length(effect_key) between 1 and 300
  ),
  constraint job_tool_effects_json_check check (
    jsonb_typeof(metadata) = 'object'
    and octet_length(metadata::text) <= 262144
    and (result_ref is null or octet_length(result_ref::text) <= 262144)
  ),
  unique (job_id, tool_call_id),
  unique (principal_id, effect_key)
);

create index if not exists job_tool_effects_recovery_idx
  on public.job_tool_effects(job_id, status, replay_safe);

create table if not exists public.job_outbox (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  principal_id uuid not null,
  topic text not null check (topic ~ '^[a-z][a-z0-9_.-]{0,127}$'),
  dedupe_key text not null check (length(dedupe_key) between 1 and 300),
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending'
    check (status in ('pending', 'publishing', 'published', 'failed', 'dead')),
  attempts integer not null default 0 check (attempts >= 0),
  available_at timestamptz not null default now(),
  locked_by text,
  lock_expires_at timestamptz,
  published_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint job_outbox_payload_check check (
    octet_length(payload::text) <= 1048576
  ),
  constraint job_outbox_lock_shape_check check (
    (locked_by is null) = (lock_expires_at is null)
  ),
  unique (job_id, dedupe_key)
);

create index if not exists job_outbox_ready_idx
  on public.job_outbox(available_at, created_at)
  where status in ('pending', 'failed');
create index if not exists job_outbox_expired_lock_idx
  on public.job_outbox(lock_expires_at)
  where status = 'publishing';

create table if not exists public.ledger_entries (
  id uuid primary key default gen_random_uuid(),
  principal_id uuid not null,
  job_id uuid not null references public.jobs(id) on delete restrict,
  idempotency_key text not null check (length(idempotency_key) between 1 and 300),
  reason text not null check (length(reason) between 1 and 200),
  direction text not null default 'debit' check (direction in ('debit', 'credit')),
  weighted_tokens bigint not null default 0 check (weighted_tokens >= 0),
  raw_tokens bigint not null default 0 check (raw_tokens >= 0),
  model text,
  provider text,
  cost_estimate numeric(20, 8) not null default 0 check (cost_estimate >= 0),
  currency text not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint ledger_entries_metadata_check check (
    jsonb_typeof(metadata) = 'object' and octet_length(metadata::text) <= 262144
  ),
  unique (principal_id, idempotency_key)
);

create index if not exists ledger_entries_principal_created_idx
  on public.ledger_entries(principal_id, created_at desc);
create index if not exists ledger_entries_job_idx
  on public.ledger_entries(job_id, created_at);

create table if not exists public.audit_log (
  id uuid primary key default gen_random_uuid(),
  principal_id uuid,
  actor_type text not null check (actor_type in ('user', 'service', 'worker', 'system')),
  actor_id text,
  action text not null check (action ~ '^[a-z][a-z0-9_.-]{1,199}$'),
  resource_type text not null check (length(resource_type) between 1 and 100),
  resource_id text,
  job_id uuid references public.jobs(id) on delete restrict,
  request_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint audit_log_metadata_check check (
    jsonb_typeof(metadata) = 'object' and octet_length(metadata::text) <= 262144
  )
);

create index if not exists audit_log_principal_created_idx
  on public.audit_log(principal_id, created_at desc);
create index if not exists audit_log_job_created_idx
  on public.audit_log(job_id, created_at);

-- Message SoR projection. Existing rows become immutable-identity terminal
-- snapshots, while a service enqueue may bind an assistant placeholder to a job.
alter table public.messages
  add column if not exists seq bigint,
  add column if not exists content_parts jsonb not null default '[]'::jsonb,
  add column if not exists thinking_parts jsonb not null default '[]'::jsonb,
  add column if not exists media_refs jsonb not null default '[]'::jsonb,
  add column if not exists generation_id uuid references public.jobs(id) on delete set null,
  add column if not exists status text not null default 'terminal',
  add column if not exists identity_locked boolean not null default true,
  add column if not exists content_hash text,
  add column if not exists updated_at timestamptz not null default now();

with conversation_offsets as (
  select conversation_id, coalesce(max(seq), 0) as base_seq
  from public.messages
  where seq is not null
  group by conversation_id
), missing_sequences as (
  select message.id,
    coalesce(conversation_offsets.base_seq, 0)
      + row_number() over (
          partition by message.conversation_id
          order by message.created_at, message.id
        ) as assigned_seq
  from public.messages as message
  left join conversation_offsets
    on conversation_offsets.conversation_id = message.conversation_id
  where message.seq is null
)
update public.messages as message
set seq = missing_sequences.assigned_seq
from missing_sequences
where message.id = missing_sequences.id;

update public.messages
set content_parts = case
      when content_parts <> '[]'::jsonb or content = '' then content_parts
      else jsonb_build_array(jsonb_build_object('type', 'text', 'text', content))
    end,
    thinking_parts = case
      when thinking_parts <> '[]'::jsonb or coalesce(thinking, '') = '' then thinking_parts
      else jsonb_build_array(jsonb_build_object('type', 'text', 'text', thinking))
    end,
    media_refs = case
      when media_refs <> '[]'::jsonb then media_refs
      when jsonb_typeof(images) = 'array'
        and jsonb_array_length(images) <= 32
        and octet_length(images::text) <= 262144 then images
      when jsonb_typeof(images->'refs') = 'array'
        and jsonb_array_length(images->'refs') <= 32
        and octet_length((images->'refs')::text) <= 262144 then images->'refs'
      else '[]'::jsonb
    end
where content_hash is null;

-- PostgreSQL assignments in one UPDATE read the old row. Hash in a second
-- statement so the fingerprint always covers the backfilled final parts.
update public.messages
set content_hash = md5(
  coalesce(content_parts, '[]'::jsonb)::text || E'\n'
  || coalesce(thinking_parts, '[]'::jsonb)::text || E'\n'
  || coalesce(media_refs, '[]'::jsonb)::text
);

alter table public.messages alter column seq set not null;
alter table public.messages alter column content_hash set not null;
alter table public.messages drop constraint if exists messages_status_check;
alter table public.messages add constraint messages_status_check
  check (status in ('draft', 'streaming', 'terminal'));
alter table public.messages drop constraint if exists messages_parts_shape_check;
alter table public.messages add constraint messages_parts_shape_check check (
  jsonb_typeof(content_parts) = 'array'
  and jsonb_array_length(content_parts) <= 256
  and octet_length(content_parts::text) <= 1048576
  and jsonb_typeof(thinking_parts) = 'array'
  and jsonb_array_length(thinking_parts) <= 128
  and octet_length(thinking_parts::text) <= 1048576
  and jsonb_typeof(media_refs) = 'array'
  and jsonb_array_length(media_refs) <= 32
  and octet_length(media_refs::text) <= 262144
);
alter table public.messages drop constraint if exists messages_generation_role_check;
alter table public.messages add constraint messages_generation_role_check
  check (generation_id is null or role = 'assistant');
alter table public.messages drop constraint if exists messages_content_hash_check;
alter table public.messages add constraint messages_content_hash_check
  check (content_hash ~ '^[0-9a-f]{32}$');

create unique index if not exists messages_conversation_seq_idx
  on public.messages(conversation_id, seq);
create unique index if not exists messages_generation_id_idx
  on public.messages(generation_id) where generation_id is not null;

create or replace function public.enforce_message_sor_contract()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    if current_user in ('authenticated', 'anon') and new.generation_id is not null then
      raise exception 'generated_message_service_owned' using errcode = '42501';
    end if;
    -- The conversation row is the per-conversation sequence allocator. The row
    -- lock makes concurrent inserts serialize without a global sequence.
    perform 1
    from public.conversations
    where id = new.conversation_id and user_id = new.user_id
    for update;
    if not found then
      raise exception 'message_parent_not_found' using errcode = '23503';
    end if;

    select coalesce(max(message.seq), 0) + 1
    into new.seq
    from public.messages as message
    where message.conversation_id = new.conversation_id;

    if new.content_parts = '[]'::jsonb and new.content <> '' then
      new.content_parts := jsonb_build_array(
        jsonb_build_object('type', 'text', 'text', new.content)
      );
    end if;
    if new.thinking_parts = '[]'::jsonb and coalesce(new.thinking, '') <> '' then
      new.thinking_parts := jsonb_build_array(
        jsonb_build_object('type', 'text', 'text', new.thinking)
      );
    end if;
    new.identity_locked := true;
    if new.generation_id is not null then
      perform 1
      from public.jobs
      where id = new.generation_id
        and principal_id = new.user_id
        and type = 'chat.generation'
        and subject->>'conversationId' = new.conversation_id::text
        and subject->>'assistantMessageId' = new.id::text
      for key share;
      if not found then
        raise exception 'generated_message_job_identity_mismatch' using errcode = '23503';
      end if;
    end if;
  else
    if old.identity_locked and (
      new.id is distinct from old.id
      or new.user_id is distinct from old.user_id
      or new.conversation_id is distinct from old.conversation_id
      or new.role is distinct from old.role
      or new.created_at is distinct from old.created_at
      or new.seq is distinct from old.seq
      or not new.identity_locked
    ) then
      raise exception 'message_identity_immutable' using errcode = '55000';
    end if;

    if old.generation_id is not null
       and new.generation_id is distinct from old.generation_id then
      raise exception 'message_generation_identity_immutable' using errcode = '55000';
    end if;

    -- Browser sessions cannot bind or mutate a generated assistant snapshot.
    -- SECURITY DEFINER control-plane functions execute as the function owner.
    if current_user in ('authenticated', 'anon') and (
      new.generation_id is distinct from old.generation_id
      or (old.generation_id is not null and (
        new.status is distinct from old.status
        or new.content is distinct from old.content
        or new.thinking is distinct from old.thinking
        or new.images is distinct from old.images
        or new.content_parts is distinct from old.content_parts
        or new.thinking_parts is distinct from old.thinking_parts
        or new.media_refs is distinct from old.media_refs
        or new.content_hash is distinct from old.content_hash
      ))
    ) then
      raise exception 'generated_message_service_owned' using errcode = '42501';
    end if;

    if new.generation_id is distinct from old.generation_id
       and new.generation_id is not null then
      perform 1
      from public.jobs
      where id = new.generation_id
        and principal_id = new.user_id
        and type = 'chat.generation'
        and subject->>'conversationId' = new.conversation_id::text
        and subject->>'assistantMessageId' = new.id::text
      for key share;
      if not found then
        raise exception 'generated_message_job_identity_mismatch' using errcode = '23503';
      end if;
    end if;

    if old.generation_id is not null and old.status = 'terminal' and (
      new.status <> 'terminal'
      or new.content is distinct from old.content
      or new.thinking is distinct from old.thinking
      or new.images is distinct from old.images
      or new.content_parts is distinct from old.content_parts
      or new.thinking_parts is distinct from old.thinking_parts
      or new.media_refs is distinct from old.media_refs
    ) then
      raise exception 'terminal_message_immutable' using errcode = '55000';
    end if;
  end if;

  new.content_hash := md5(
    coalesce(new.content_parts, '[]'::jsonb)::text || E'\n'
    || coalesce(new.thinking_parts, '[]'::jsonb)::text || E'\n'
    || coalesce(new.media_refs, '[]'::jsonb)::text
  );
  new.updated_at := clock_timestamp();
  return new;
end;
$$;

drop trigger if exists enforce_message_sor_contract on public.messages;
create trigger enforce_message_sor_contract
before insert or update on public.messages
for each row execute function public.enforce_message_sor_contract();

create or replace function public.enforce_job_state_contract()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if old.status in ('completed', 'failed', 'cancelled') and new is distinct from old then
    raise exception 'terminal_job_immutable' using errcode = '55000';
  end if;

  if new.id is distinct from old.id
     or new.type is distinct from old.type
     or new.queue is distinct from old.queue
     or new.principal_id is distinct from old.principal_id
     or new.auth_class is distinct from old.auth_class
     or new.subject is distinct from old.subject
     or new.idempotency_key is distinct from old.idempotency_key
     or new.input_hash is distinct from old.input_hash
     or new.payload is distinct from old.payload
     or new.budget is distinct from old.budget
     or new.max_attempts is distinct from old.max_attempts
     or new.created_at is distinct from old.created_at then
    raise exception 'job_identity_immutable' using errcode = '55000';
  end if;

  if not (
    new.status = old.status
    or (old.status = 'queued' and new.status in ('leased', 'failed', 'cancelled'))
    or (old.status = 'leased' and new.status in (
      'queued', 'running', 'awaiting_input', 'cancelling', 'completed', 'failed', 'cancelled'
    ))
    or (old.status = 'running' and new.status in (
      'queued', 'leased', 'awaiting_input', 'cancelling', 'completed', 'failed', 'cancelled'
    ))
    or (old.status = 'awaiting_input' and new.status in (
      'running', 'cancelling', 'completed', 'failed', 'cancelled'
    ))
    or (old.status = 'cancelling' and new.status in ('completed', 'failed', 'cancelled'))
  ) then
    raise exception 'invalid_job_state_transition:%->%', old.status, new.status
      using errcode = '55000';
  end if;

  if new.lease_version < old.lease_version then
    raise exception 'job_lease_version_regressed' using errcode = '55000';
  end if;
  if new.lease_owner is distinct from old.lease_owner
     and new.lease_owner is not null
     and new.lease_version <= old.lease_version then
    raise exception 'job_lease_owner_changed_without_fence' using errcode = '55000';
  end if;
  if new.attempt < old.attempt or new.event_sequence < old.event_sequence then
    raise exception 'job_monotonic_counter_regressed' using errcode = '55000';
  end if;
  if old.cancel_requested_at is not null and new.cancel_requested_at is null then
    raise exception 'job_cancel_request_immutable' using errcode = '55000';
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_job_state_contract on public.jobs;
create trigger enforce_job_state_contract
before update on public.jobs
for each row execute function public.enforce_job_state_contract();

create or replace function public.reject_append_only_mutation()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception '% is append_only', tg_table_name using errcode = '55000';
end;
$$;

drop trigger if exists job_events_append_only on public.job_events;
create trigger job_events_append_only
before update or delete on public.job_events
for each row execute function public.reject_append_only_mutation();
drop trigger if exists ledger_entries_append_only on public.ledger_entries;
create trigger ledger_entries_append_only
before update or delete on public.ledger_entries
for each row execute function public.reject_append_only_mutation();
drop trigger if exists audit_log_append_only on public.audit_log;
create trigger audit_log_append_only
before update or delete on public.audit_log
for each row execute function public.reject_append_only_mutation();

-- RLS remains the last line of tenant isolation. Control tables have no write
-- policies; SECURITY DEFINER functions are the sole state mutation interface.
alter table public.jobs enable row level security;
alter table public.job_events enable row level security;
alter table public.job_checkpoints enable row level security;
alter table public.job_tool_effects enable row level security;
alter table public.job_outbox enable row level security;
alter table public.ledger_entries enable row level security;
alter table public.audit_log enable row level security;

drop policy if exists jobs_select_own on public.jobs;
create policy jobs_select_own on public.jobs for select to authenticated
  using (principal_id = auth.uid());
drop policy if exists job_events_select_own on public.job_events;
create policy job_events_select_own on public.job_events for select to authenticated
  using (principal_id = auth.uid());
drop policy if exists ledger_entries_select_own on public.ledger_entries;
create policy ledger_entries_select_own on public.ledger_entries for select to authenticated
  using (principal_id = auth.uid());
drop policy if exists audit_log_service_select on public.audit_log;
create policy audit_log_service_select on public.audit_log for select to service_role
  using (true);

revoke all on table public.jobs, public.job_events, public.job_checkpoints,
  public.job_tool_effects, public.job_outbox, public.ledger_entries, public.audit_log
  from public, anon, authenticated, service_role;

grant select on table public.jobs, public.job_events, public.job_checkpoints,
  public.job_tool_effects, public.ledger_entries, public.audit_log to service_role;
grant select on table public.job_outbox to service_role;
grant update (
  status, attempts, available_at, locked_by, lock_expires_at, published_at,
  last_error, updated_at
) on table public.job_outbox to service_role;

grant select (
  id, type, queue, principal_id, auth_class, subject, status, attempt,
  max_attempts, priority, available_at, cancel_requested_at, progress, result,
  error_class, error_code, event_sequence, created_at, updated_at, started_at,
  terminal_at
) on table public.jobs to authenticated;
grant select (
  id, job_id, principal_id, seq, kind, schema_version, payload, created_at
) on table public.job_events to authenticated;
grant select (
  id, principal_id, job_id, reason, direction, weighted_tokens, raw_tokens,
  model, provider, cost_estimate, currency, metadata, created_at
) on table public.ledger_entries to authenticated;

create or replace function public.job_contract_json(input_job public.jobs)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'id', input_job.id,
    'type', input_job.type,
    'queue', input_job.queue,
    'principalId', input_job.principal_id,
    'authClass', input_job.auth_class,
    'subject', input_job.subject,
    'inputHash', input_job.input_hash,
    'payload', input_job.payload,
    'budget', input_job.budget,
    'status', input_job.status,
    'attempt', input_job.attempt,
    'maxAttempts', input_job.max_attempts,
    'priority', input_job.priority,
    'availableAt', input_job.available_at,
    'leaseOwner', input_job.lease_owner,
    'leaseVersion', input_job.lease_version,
    'leaseExpiresAt', input_job.lease_expires_at,
    'cancelRequestedAt', input_job.cancel_requested_at,
    'cancelReason', input_job.cancel_reason,
    'progress', input_job.progress,
    'result', input_job.result,
    'errorClass', input_job.error_class,
    'errorCode', input_job.error_code,
    'eventSeq', input_job.event_sequence,
    'checkpoint', (
      select jsonb_build_object(
        'version', checkpoint.version,
        'phase', checkpoint.phase,
        'data', checkpoint.checkpoint,
        'progress', checkpoint.progress,
        'resumable', checkpoint.resumable,
        'leaseVersion', checkpoint.lease_version,
        'updatedAt', checkpoint.updated_at
      )
      from public.job_checkpoints as checkpoint
      where checkpoint.job_id = input_job.id
    ),
    'createdAt', input_job.created_at,
    'updatedAt', input_job.updated_at,
    'startedAt', input_job.started_at,
    'terminalAt', input_job.terminal_at
  );
$$;

revoke all on function public.job_contract_json(public.jobs)
  from public, anon, authenticated, service_role;

create or replace function public.enqueue_job(
  input_job_id uuid,
  input_type text,
  input_queue text,
  input_principal_id uuid,
  input_auth_class text,
  input_subject jsonb,
  input_idempotency_key text,
  input_input_hash text default null,
  input_payload jsonb default '{}'::jsonb,
  input_budget jsonb default '{}'::jsonb,
  input_priority integer default 0,
  input_max_attempts integer default 3,
  input_available_at timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_job public.jobs%rowtype;
  normalized_subject jsonb := coalesce(input_subject, '{}'::jsonb);
  normalized_payload jsonb := coalesce(input_payload, '{}'::jsonb);
  normalized_budget jsonb := coalesce(input_budget, '{}'::jsonb);
  conversation_text text;
  assistant_text text;
  user_message_text text;
  session_text text;
  response_text text;
  conversation_uuid uuid;
  assistant_uuid uuid;
  user_message_uuid uuid;
  session_uuid uuid;
  response_uuid uuid;
  payload_ref_name text;
  payload_ref_hash text;
  payload_ref_bytes bigint;
  uuid_pattern constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$';
  v_now timestamptz := clock_timestamp();
begin
  if input_job_id is null or input_principal_id is null
     or input_type is null or input_type !~ '^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)+$'
     or input_queue is null or input_queue !~ '^[a-z][a-z0-9_.-]{0,63}$'
     or input_auth_class not in ('anonymous', 'registered', 'service')
     or input_idempotency_key is null
     or length(input_idempotency_key) not between 1 and 256
     or input_input_hash is null or length(input_input_hash) not between 16 and 256
     or input_priority not between -1000 and 1000
     or input_max_attempts not between 1 and 100
     or input_available_at is null
     or jsonb_typeof(normalized_subject) <> 'object'
     or jsonb_typeof(normalized_payload) <> 'object'
     or jsonb_typeof(normalized_budget) <> 'object'
     or octet_length(normalized_subject::text) > 262144
     or octet_length(normalized_payload::text) > 1048576
     or octet_length(normalized_budget::text) > 262144 then
    raise exception 'invalid_job_enqueue' using errcode = '22023';
  end if;

  if not exists (select 1 from auth.users where id = input_principal_id) then
    raise exception 'job_principal_not_found' using errcode = '23503';
  end if;

  if normalized_payload ? 'payloadRef' then
    if jsonb_typeof(normalized_payload->'payloadRef') = 'object' then
      if normalized_payload->'payloadRef'->>'bucket' <> 'job-payloads'
         or normalized_payload->'payloadRef'->>'contentType' <> 'application/json'
         or coalesce(normalized_payload->'payloadRef'->>'bytes', '') !~ '^[0-9]{1,8}$' then
        raise exception 'invalid_job_payload_reference' using errcode = '22023';
      end if;
      payload_ref_name := normalized_payload->'payloadRef'->>'objectKey';
      payload_ref_hash := normalized_payload->'payloadRef'->>'sha256';
      payload_ref_bytes := (normalized_payload->'payloadRef'->>'bytes')::bigint;
    elsif jsonb_typeof(normalized_payload->'payloadRef') = 'string' then
      payload_ref_name := normalized_payload->>'payloadRef';
      payload_ref_hash := normalized_payload->>'payloadHash';
      payload_ref_bytes := null;
    else
      raise exception 'invalid_job_payload_reference' using errcode = '22023';
    end if;
    if length(coalesce(payload_ref_name, '')) not between 1 and 512
       or coalesce(payload_ref_hash, '') !~ '^[0-9a-f]{64}$'
       or (payload_ref_bytes is not null and payload_ref_bytes not between 2 and 50331648)
       or payload_ref_name <>
         input_principal_id::text || '/' || input_job_id::text || '/'
         || payload_ref_hash || '.json' then
      raise exception 'invalid_job_payload_reference' using errcode = '22023';
    end if;
    perform 1 from storage.objects
    where bucket_id = 'job-payloads'
      and name = payload_ref_name
    for key share;
    if not found then
      raise exception 'job_payload_not_found' using errcode = '23503';
    end if;
  end if;

  select * into current_job
  from public.jobs
  where principal_id = input_principal_id
    and idempotency_key = input_idempotency_key
  for update;
  if found then
    if current_job.type <> input_type
       or current_job.input_hash <> input_input_hash then
      raise exception 'job_idempotency_conflict' using errcode = '23505';
    end if;
    return jsonb_build_object(
      'enqueued', false,
      'replayed', true,
      'job', public.job_contract_json(current_job)
    );
  end if;

  if exists (select 1 from public.jobs where id = input_job_id) then
    raise exception 'job_id_conflict' using errcode = '23505';
  end if;

  if input_type = 'chat.generation' then
    if coalesce(normalized_payload->>'outputKind', 'text') not in ('text', 'image', 'video') then
      raise exception 'invalid_chat_output_kind' using errcode = '22023';
    end if;
    normalized_payload := normalized_payload || jsonb_build_object(
      'outputKind', coalesce(normalized_payload->>'outputKind', 'text')
    );
    conversation_text := coalesce(
      normalized_subject->>'conversationId', normalized_payload->>'conversationId'
    );
    assistant_text := coalesce(
      normalized_subject->>'assistantMessageId', normalized_payload->>'assistantMessageId'
    );
    user_message_text := coalesce(
      normalized_subject->>'userMessageId', normalized_payload->>'userMessageId'
    );
    if conversation_text is null or conversation_text !~ uuid_pattern
       or assistant_text is null or assistant_text !~ uuid_pattern
       or user_message_text is null or user_message_text !~ uuid_pattern then
      raise exception 'invalid_chat_job_identity' using errcode = '22023';
    end if;
    conversation_uuid := conversation_text::uuid;
    assistant_uuid := assistant_text::uuid;
    user_message_uuid := user_message_text::uuid;
    normalized_subject := normalized_subject || jsonb_build_object(
      'conversationId', conversation_uuid,
      'assistantMessageId', assistant_uuid,
      'userMessageId', user_message_uuid
    );

    perform 1 from public.conversations
    where id = conversation_uuid and user_id = input_principal_id
    for key share;
    if not found then
      raise exception 'chat_job_parent_not_found' using errcode = '23503';
    end if;

    perform 1 from public.messages
    where id = user_message_uuid
      and user_id = input_principal_id
      and conversation_id = conversation_uuid
      and role = 'user'
    for key share;
    if not found then
      raise exception 'chat_job_user_message_mismatch' using errcode = '23503';
    end if;

    perform 1 from public.messages
    where id = assistant_uuid
      and user_id = input_principal_id
      and conversation_id = conversation_uuid
      and role = 'assistant'
      and generation_id is null
    for update;
    if not found then
      raise exception 'chat_job_assistant_message_mismatch' using errcode = '23503';
    end if;

    if exists (
      select 1 from public.jobs
      where principal_id = input_principal_id
        and type = 'chat.generation'
        and subject->>'conversationId' = conversation_uuid::text
        and status in ('queued', 'leased', 'running', 'awaiting_input', 'cancelling')
    ) then
      raise exception 'chat_conversation_job_active' using errcode = '23505';
    end if;
  elsif input_type = 'chat.title' then
    conversation_text := coalesce(
      normalized_subject->>'conversationId', normalized_payload->>'conversationId'
    );
    if conversation_text is null or conversation_text !~ uuid_pattern then
      raise exception 'invalid_chat_title_identity' using errcode = '22023';
    end if;
    conversation_uuid := conversation_text::uuid;
    normalized_subject := normalized_subject || jsonb_build_object(
      'conversationId', conversation_uuid
    );
    perform 1 from public.conversations
    where id = conversation_uuid and user_id = input_principal_id
    for key share;
    if not found then
      raise exception 'chat_title_parent_not_found' using errcode = '23503';
    end if;
  elsif input_type = 'agent.task' then
    session_text := normalized_subject->>'sessionId';
    response_text := normalized_subject->>'responseId';
    user_message_text := normalized_subject->>'userMessageId';
    if coalesce(normalized_subject->>'taskId', '') !~ uuid_pattern
       or coalesce(session_text, '') !~ uuid_pattern
       or coalesce(response_text, '') !~ uuid_pattern
       or coalesce(user_message_text, '') !~ uuid_pattern then
      raise exception 'invalid_agent_job_identity' using errcode = '22023';
    end if;
    session_uuid := session_text::uuid;
    response_uuid := response_text::uuid;
    user_message_uuid := user_message_text::uuid;
    normalized_subject := normalized_subject || jsonb_build_object(
      'sessionId', session_uuid,
      'responseId', response_uuid,
      'userMessageId', user_message_uuid
    );
    perform 1 from public.agent_tasks
    where id = (normalized_subject->>'taskId')::uuid
      and user_id = input_principal_id
    for key share;
    if not found then
      raise exception 'agent_job_task_not_found' using errcode = '23503';
    end if;
    perform 1 from public.code_sessions
    where id = session_uuid and user_id = input_principal_id
      and repo = normalized_subject->>'repo'
    for key share;
    if not found then
      raise exception 'agent_job_session_mismatch' using errcode = '23503';
    end if;
    perform 1 from public.code_messages
    where id = user_message_uuid and session_id = session_uuid
      and user_id = input_principal_id and role = 'user'
    for key share;
    if not found then
      raise exception 'agent_job_user_message_mismatch' using errcode = '23503';
    end if;
    perform 1 from public.code_messages where id = response_uuid for update;
    if found and not exists (
      select 1 from public.code_messages
      where id = response_uuid and session_id = session_uuid
        and user_id = input_principal_id and role = 'assistant' and content = ''
    ) then
      raise exception 'agent_job_response_mismatch' using errcode = '23505';
    end if;
  end if;

  insert into public.jobs(
    id, type, queue, principal_id, auth_class, subject, idempotency_key,
    input_hash, payload, budget, priority, max_attempts, available_at,
    status, event_sequence, created_at, updated_at
  ) values (
    input_job_id, input_type, input_queue, input_principal_id, input_auth_class,
    normalized_subject, input_idempotency_key, input_input_hash,
    normalized_payload, normalized_budget, input_priority, input_max_attempts,
    input_available_at, 'queued', 1, v_now, v_now
  ) returning * into current_job;

  insert into public.job_events(
    job_id, principal_id, seq, kind, payload, created_at
  ) values (
    current_job.id, current_job.principal_id, 1, 'job.accepted',
    jsonb_build_object(
      'status', 'queued', 'type', current_job.type, 'queue', current_job.queue
    ),
    v_now
  );

  insert into public.job_outbox(
    job_id, principal_id, topic, dedupe_key, payload, available_at,
    created_at, updated_at
  ) values (
    current_job.id, current_job.principal_id, 'jobs.ready',
    current_job.id::text || ':ready',
    jsonb_build_object(
      'jobId', current_job.id, 'queue', current_job.queue, 'type', current_job.type
    ),
    current_job.available_at, v_now, v_now
  );

  insert into public.audit_log(
    principal_id, actor_type, actor_id, action, resource_type, resource_id,
    job_id, metadata, created_at
  ) values (
    current_job.principal_id, 'service', current_job.principal_id::text,
    'job.enqueued', 'job', current_job.id::text, current_job.id,
    jsonb_build_object(
      'type', current_job.type, 'queue', current_job.queue,
      'idempotencyKey', current_job.idempotency_key
    ),
    v_now
  );

  if current_job.type = 'chat.generation' then
    insert into public.chat_generations(
      id, user_id, conversation_id, assistant_message_id, status,
      content, thinking, sequence, error, media, lease_owner,
      lease_expires_at, lease_version, updated_at
    ) values (
      current_job.id, current_job.principal_id, conversation_uuid,
      assistant_uuid, 'queued', '', '', 1, null, '[]'::jsonb,
      null, null, 0, v_now
    );

    update public.messages
    set generation_id = current_job.id,
        status = 'streaming',
        identity_locked = true,
        updated_at = v_now
    where id = assistant_uuid
      and user_id = current_job.principal_id
      and conversation_id = conversation_uuid
      and role = 'assistant'
      and generation_id is null;
    if not found then
      raise exception 'chat_job_assistant_bind_failed' using errcode = '40001';
    end if;
  elsif current_job.type = 'agent.task' then
    insert into public.code_messages(
      id, session_id, user_id, role, content, meta, created_at
    ) values (
      response_uuid, session_uuid, current_job.principal_id, 'assistant', '',
      jsonb_build_object(
        'taskId', current_job.subject->>'taskId',
        'jobId', current_job.id,
        'status', 'queued'
      ),
      v_now
    ) on conflict (id) do nothing;
  end if;

  return jsonb_build_object(
    'enqueued', true,
    'replayed', false,
    'job', public.job_contract_json(current_job)
  );
end;
$$;

revoke all on function public.enqueue_job(
  uuid,text,text,uuid,text,jsonb,text,text,jsonb,jsonb,integer,integer,timestamptz
) from public, anon, authenticated;
grant execute on function public.enqueue_job(
  uuid,text,text,uuid,text,jsonb,text,text,jsonb,jsonb,integer,integer,timestamptz
) to service_role;

create or replace function public.mirror_chat_job_terminal(input_job public.jobs)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  terminal_content text := coalesce(
    input_job.result->>'content', input_job.progress->>'content', ''
  );
  terminal_thinking text := coalesce(
    input_job.result->>'thinking', input_job.progress->>'thinking', ''
  );
  terminal_parts jsonb;
  terminal_thinking_parts jsonb;
  terminal_media_refs jsonb;
  legacy_media jsonb := '[]'::jsonb;
begin
  if input_job.type <> 'chat.generation' then return; end if;

  terminal_parts := case
    when jsonb_typeof(input_job.result->'contentParts') = 'array'
      then input_job.result->'contentParts'
    when terminal_content <> ''
      then jsonb_build_array(jsonb_build_object('type', 'text', 'text', terminal_content))
    else '[]'::jsonb
  end;
  terminal_thinking_parts := case
    when jsonb_typeof(input_job.result->'thinkingParts') = 'array'
      then input_job.result->'thinkingParts'
    when terminal_thinking <> ''
      then jsonb_build_array(jsonb_build_object('type', 'text', 'text', terminal_thinking))
    else '[]'::jsonb
  end;
  terminal_media_refs := case
    when jsonb_typeof(input_job.result->'mediaRefs') = 'array'
      then input_job.result->'mediaRefs'
    when jsonb_typeof(input_job.result->'media') = 'array'
      then input_job.result->'media'
    else '[]'::jsonb
  end;
  if jsonb_array_length(terminal_media_refs) > 32
     or octet_length(terminal_media_refs::text) > 262144 then
    raise exception 'terminal_media_refs_too_large' using errcode = '22023';
  end if;
  if input_job.status = 'completed'
     and jsonb_array_length(terminal_media_refs) <= 4 then
    legacy_media := terminal_media_refs;
  end if;

  update public.chat_generations
  set status = input_job.status,
      content = terminal_content,
      thinking = terminal_thinking,
      sequence = least(input_job.event_sequence, 2147483647)::integer,
      error = input_job.error_code,
      media = legacy_media,
      lease_owner = null,
      lease_expires_at = null,
      updated_at = input_job.updated_at
  where id = input_job.id
    and user_id = input_job.principal_id
    and conversation_id = (input_job.subject->>'conversationId')::uuid
    and assistant_message_id = (input_job.subject->>'assistantMessageId')::uuid;
  if not found then
    raise exception 'chat_generation_projection_missing' using errcode = '23503';
  end if;

  update public.messages
  set content = terminal_content,
      thinking = nullif(terminal_thinking, ''),
      content_parts = terminal_parts,
      thinking_parts = terminal_thinking_parts,
      media_refs = terminal_media_refs,
      status = 'terminal',
      images = (
        case jsonb_typeof(images)
          when 'object' then images
          when 'array' then jsonb_build_object(
            'refs', images, 'image_summary', null
          )
          else jsonb_build_object('refs', '[]'::jsonb, 'image_summary', null)
        end
      ) || jsonb_build_object(
        'generated_media', legacy_media,
        'generation', jsonb_build_object(
          'id', input_job.id,
          'status', input_job.status,
          'sequence', least(input_job.event_sequence, 2147483647)::integer,
          'error', input_job.error_code
        )
      ),
      updated_at = input_job.updated_at
  where id = (input_job.subject->>'assistantMessageId')::uuid
    and user_id = input_job.principal_id
    and conversation_id = (input_job.subject->>'conversationId')::uuid
    and generation_id = input_job.id;
  if not found then
    raise exception 'chat_message_projection_missing' using errcode = '23503';
  end if;

  update public.conversations
  set updated_at = input_job.updated_at
  where id = (input_job.subject->>'conversationId')::uuid
    and user_id = input_job.principal_id;
end;
$$;

revoke all on function public.mirror_chat_job_terminal(public.jobs)
  from public, anon, authenticated, service_role;

create or replace function public.claim_next_job(
  input_worker_id text,
  input_queues text[] default null,
  input_lease_seconds integer default 120
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_job public.jobs%rowtype;
  v_now timestamptz := clock_timestamp();
  lease_duration integer := greatest(15, least(coalesce(input_lease_seconds, 120), 900));
  stale_recoverable boolean;
  terminal_reason text;
begin
  if input_worker_id is null or length(input_worker_id) not between 1 and 256
     or input_lease_seconds is null or input_lease_seconds not between 15 and 900
     or (
       input_queues is not null
       and exists (
         select 1 from unnest(input_queues) as queue_name
         where queue_name is null or queue_name !~ '^[a-z][a-z0-9_.-]{0,63}$'
       )
     ) then
    raise exception 'invalid_job_claim' using errcode = '22023';
  end if;

  select * into current_job
  from public.jobs as candidate
  where (
      input_queues is null
      or cardinality(input_queues) = 0
      or candidate.queue = any(input_queues)
    )
    and candidate.available_at <= v_now
    and (
      candidate.status = 'queued'
      or (
        candidate.status in ('leased', 'running', 'cancelling')
        and (candidate.lease_expires_at is null or candidate.lease_expires_at <= v_now)
      )
    )
  order by candidate.priority desc,
    (
      select count(*) from public.jobs as active
      where active.principal_id = candidate.principal_id
        and active.status in ('leased', 'running', 'cancelling')
        and active.lease_expires_at > v_now
    ) asc,
    candidate.available_at, candidate.created_at, candidate.id
  for update skip locked
  limit 1;

  if not found then
    return jsonb_build_object('acquired', false, 'reason', 'empty', 'job', null);
  end if;

  if current_job.status = 'cancelling' or current_job.cancel_requested_at is not null then
    update public.jobs
    set status = 'cancelled',
        result = coalesce(result, '{}'::jsonb),
        error_class = null,
        error_code = null,
        event_sequence = event_sequence + 1,
        lease_owner = null,
        lease_expires_at = null,
        terminal_at = v_now,
        updated_at = v_now
    where id = current_job.id
    returning * into current_job;

    insert into public.job_events(
      job_id, principal_id, seq, kind, payload, created_at
    ) values (
      current_job.id, current_job.principal_id, current_job.event_sequence,
      'job.terminal',
      jsonb_build_object(
        'status', current_job.status, 'result', current_job.result,
        'errorClass', current_job.error_class, 'errorCode', current_job.error_code,
        'retryable', current_job.error_class in ('retryable', 'provider')
      ),
      v_now
    );
    insert into public.job_outbox(
      job_id, principal_id, topic, dedupe_key, payload, created_at, updated_at
    ) values (
      current_job.id, current_job.principal_id, 'jobs.terminal',
      current_job.id::text || ':terminal',
      jsonb_build_object('jobId', current_job.id, 'status', current_job.status),
      v_now, v_now
    ) on conflict (job_id, dedupe_key) do nothing;
    perform public.mirror_chat_job_terminal(current_job);
    return jsonb_build_object(
      'acquired', false, 'reason', 'cancelled',
      'job', public.job_contract_json(current_job)
    );
  end if;

  if current_job.status <> 'queued' then
    select not exists (
      select 1 from public.job_tool_effects
      where job_id = current_job.id
        and (
          status in ('running', 'unknown')
          or (
            not replay_safe and (
              status = 'failed'
              or (status = 'succeeded' and not (coalesce(result_ref, '{}'::jsonb) ? 'result'))
            )
          )
        )
    ) into stale_recoverable;

    if current_job.attempt >= current_job.max_attempts or not stale_recoverable then
      terminal_reason := case
        when current_job.attempt >= current_job.max_attempts
          then 'job_attempts_exhausted'
        else 'stale_lease_unrecoverable'
      end;
      update public.jobs
      set status = 'failed',
          result = coalesce(result, '{}'::jsonb),
          error_class = 'internal',
          error_code = terminal_reason,
          event_sequence = event_sequence + 1,
          lease_owner = null,
          lease_expires_at = null,
          terminal_at = v_now,
          updated_at = v_now
      where id = current_job.id
      returning * into current_job;

      insert into public.job_events(
        job_id, principal_id, seq, kind, payload, created_at
      ) values (
        current_job.id, current_job.principal_id, current_job.event_sequence,
        'job.terminal',
        jsonb_build_object(
          'status', current_job.status, 'result', current_job.result,
          'errorClass', current_job.error_class, 'errorCode', current_job.error_code,
          'retryable', current_job.error_class in ('retryable', 'provider')
        ),
        v_now
      );
      insert into public.job_outbox(
        job_id, principal_id, topic, dedupe_key, payload, created_at, updated_at
      ) values (
        current_job.id, current_job.principal_id, 'jobs.terminal',
        current_job.id::text || ':terminal',
        jsonb_build_object(
          'jobId', current_job.id, 'status', current_job.status,
          'errorCode', current_job.error_code
        ),
        v_now, v_now
      ) on conflict (job_id, dedupe_key) do nothing;
      perform public.mirror_chat_job_terminal(current_job);
      return jsonb_build_object(
        'acquired', false, 'reason', terminal_reason,
        'job', public.job_contract_json(current_job)
      );
    end if;
  end if;

  update public.jobs
  set status = 'leased',
      attempt = attempt + 1,
      lease_owner = input_worker_id,
      lease_version = lease_version + 1,
      lease_expires_at = v_now + make_interval(secs => lease_duration),
      started_at = coalesce(started_at, v_now),
      event_sequence = event_sequence + 1,
      updated_at = v_now
  where id = current_job.id
  returning * into current_job;

  insert into public.job_events(
    job_id, principal_id, seq, kind, payload, worker_id, lease_version, created_at
  ) values (
    current_job.id, current_job.principal_id, current_job.event_sequence,
    'job.leased',
    jsonb_build_object(
      'status', current_job.status,
      'attempt', current_job.attempt,
      'leaseVersion', current_job.lease_version,
      'leaseExpiresAt', current_job.lease_expires_at
    ),
    input_worker_id, current_job.lease_version, v_now
  );

  if current_job.type = 'chat.generation' then
    update public.chat_generations
    set status = 'running',
        sequence = least(current_job.event_sequence, 2147483647)::integer,
        updated_at = v_now
    where id = current_job.id and status = 'queued';
  elsif current_job.type = 'agent.task' then
    update public.agent_tasks
    set status = 'running', updated_at = v_now,
        started_at = coalesce(started_at, v_now)
    where id = (current_job.subject->>'taskId')::uuid
      and user_id = current_job.principal_id
      and status not in ('completed', 'failed', 'cancelled');
  end if;

  return jsonb_build_object(
    'acquired', true,
    'job', public.job_contract_json(current_job)
  );
end;
$$;

revoke all on function public.claim_next_job(text,text[],integer)
  from public, anon, authenticated;
grant execute on function public.claim_next_job(text,text[],integer)
  to service_role;

create or replace function public.renew_job_lease(
  input_job_id uuid,
  input_worker_id text,
  input_lease_version bigint,
  input_lease_seconds integer default 120
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_job public.jobs%rowtype;
  v_now timestamptz := clock_timestamp();
  lease_duration integer := greatest(15, least(coalesce(input_lease_seconds, 120), 900));
begin
  if input_job_id is null or input_worker_id is null
     or length(input_worker_id) not between 1 and 256
     or input_lease_version is null or input_lease_version < 1
     or input_lease_seconds is null or input_lease_seconds not between 15 and 900 then
    raise exception 'invalid_job_lease_renewal' using errcode = '22023';
  end if;

  select * into current_job from public.jobs
  where id = input_job_id
  for update;
  if not found then
    return jsonb_build_object(
      'renewed', false, 'reason', 'not_found', 'status', null,
      'leaseVersion', null, 'leaseExpiresAt', null, 'cancelRequested', false
    );
  end if;
  if current_job.status in ('completed', 'failed', 'cancelled') then
    return jsonb_build_object(
      'renewed', false, 'reason', 'terminal', 'status', current_job.status,
      'leaseVersion', current_job.lease_version,
      'leaseExpiresAt', current_job.lease_expires_at,
      'cancelRequested', current_job.cancel_requested_at is not null
    );
  end if;
  if current_job.lease_owner is distinct from input_worker_id
     or current_job.lease_version <> input_lease_version then
    return jsonb_build_object(
      'renewed', false, 'reason', 'stale_fence', 'status', current_job.status,
      'leaseVersion', current_job.lease_version,
      'leaseExpiresAt', current_job.lease_expires_at,
      'cancelRequested', current_job.cancel_requested_at is not null
    );
  end if;
  if current_job.lease_expires_at is null or current_job.lease_expires_at <= v_now then
    return jsonb_build_object(
      'renewed', false, 'reason', 'expired', 'status', current_job.status,
      'leaseVersion', current_job.lease_version,
      'leaseExpiresAt', current_job.lease_expires_at,
      'cancelRequested', current_job.cancel_requested_at is not null
    );
  end if;

  update public.jobs
  set lease_expires_at = v_now + make_interval(secs => lease_duration),
      updated_at = v_now
  where id = current_job.id
    and lease_owner = input_worker_id
    and lease_version = input_lease_version
    and lease_expires_at > v_now
  returning * into current_job;

  return jsonb_build_object(
    'renewed', found,
    'reason', case when found then null else 'stale_fence' end,
    'status', current_job.status,
    'leaseVersion', current_job.lease_version,
    'leaseExpiresAt', current_job.lease_expires_at,
    'cancelRequested', current_job.cancel_requested_at is not null
  );
end;
$$;

revoke all on function public.renew_job_lease(uuid,text,bigint,integer)
  from public, anon, authenticated;
grant execute on function public.renew_job_lease(uuid,text,bigint,integer)
  to service_role;

create or replace function public.retry_job(
  input_job_id uuid,
  input_worker_id text,
  input_lease_version bigint,
  input_error_class text,
  input_error_code text,
  input_delay_seconds integer default 2
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_job public.jobs%rowtype;
  v_now timestamptz := clock_timestamp();
  retry_at timestamptz;
  unsafe_effect boolean;
begin
  if input_job_id is null or input_worker_id is null
     or length(input_worker_id) not between 1 and 256
     or input_lease_version is null or input_lease_version < 1
     or input_error_class not in ('retryable', 'provider', 'internal')
     or length(coalesce(input_error_code, '')) not between 1 and 200
     or input_delay_seconds is null or input_delay_seconds not between 1 and 3600 then
    raise exception 'invalid_job_retry' using errcode = '22023';
  end if;

  select * into current_job from public.jobs where id = input_job_id for update;
  if not found then
    return jsonb_build_object(
      'retried', false, 'reason', 'not_found', 'status', null,
      'availableAt', null, 'eventSeq', null, 'cancelRequested', false
    );
  end if;
  if current_job.status in ('completed', 'failed', 'cancelled') then
    return jsonb_build_object(
      'retried', false, 'reason', 'terminal', 'status', current_job.status,
      'availableAt', current_job.available_at, 'eventSeq', current_job.event_sequence,
      'cancelRequested', current_job.cancel_requested_at is not null
    );
  end if;
  if current_job.cancel_requested_at is not null or current_job.status = 'cancelling' then
    return jsonb_build_object(
      'retried', false, 'reason', 'cancel_requested', 'status', current_job.status,
      'availableAt', current_job.available_at, 'eventSeq', current_job.event_sequence,
      'cancelRequested', true
    );
  end if;
  if current_job.lease_owner is distinct from input_worker_id
     or current_job.lease_version <> input_lease_version
     or current_job.lease_expires_at is null or current_job.lease_expires_at <= v_now then
    return jsonb_build_object(
      'retried', false, 'reason', 'stale_fence', 'status', current_job.status,
      'availableAt', current_job.available_at, 'eventSeq', current_job.event_sequence,
      'cancelRequested', false
    );
  end if;
  if current_job.attempt >= current_job.max_attempts then
    return jsonb_build_object(
      'retried', false, 'reason', 'attempts_exhausted', 'status', current_job.status,
      'availableAt', current_job.available_at, 'eventSeq', current_job.event_sequence,
      'cancelRequested', false
    );
  end if;

  select exists (
    select 1 from public.job_tool_effects
    where job_id = current_job.id
      and (
        status in ('running', 'unknown')
        or (
          not replay_safe and (
            status = 'failed'
            or (status = 'succeeded' and not (coalesce(result_ref, '{}'::jsonb) ? 'result'))
          )
        )
      )
  ) into unsafe_effect;
  if unsafe_effect then
    return jsonb_build_object(
      'retried', false, 'reason', 'unsafe_effect', 'status', current_job.status,
      'availableAt', current_job.available_at, 'eventSeq', current_job.event_sequence,
      'cancelRequested', false
    );
  end if;

  retry_at := v_now + make_interval(secs => input_delay_seconds);
  update public.jobs
  set status = 'queued',
      available_at = retry_at,
      progress = '{}'::jsonb,
      error_class = input_error_class,
      error_code = input_error_code,
      event_sequence = event_sequence + 1,
      lease_owner = null,
      lease_expires_at = null,
      updated_at = v_now
  where id = current_job.id
    and lease_owner = input_worker_id
    and lease_version = input_lease_version
    and lease_expires_at > v_now
  returning * into current_job;
  if not found then
    raise exception 'job_fence_changed_during_retry' using errcode = '40001';
  end if;

  insert into public.job_events(
    job_id, principal_id, seq, kind, payload, worker_id, lease_version, created_at
  ) values (
    current_job.id, current_job.principal_id, current_job.event_sequence,
    'job.retry_scheduled',
    jsonb_build_object(
      'status', current_job.status,
      'attempt', current_job.attempt,
      'maxAttempts', current_job.max_attempts,
      'availableAt', retry_at,
      'errorClass', input_error_class,
      'errorCode', input_error_code
    ),
    input_worker_id, input_lease_version, v_now
  );
  insert into public.job_outbox(
    job_id, principal_id, topic, dedupe_key, payload, available_at,
    created_at, updated_at
  ) values (
    current_job.id, current_job.principal_id, 'jobs.ready',
    current_job.id::text || ':ready:retry:' || current_job.attempt::text,
    jsonb_build_object(
      'jobId', current_job.id, 'queue', current_job.queue,
      'type', current_job.type, 'attempt', current_job.attempt + 1
    ),
    retry_at, v_now, v_now
  ) on conflict (job_id, dedupe_key) do nothing;
  insert into public.audit_log(
    principal_id, actor_type, actor_id, action, resource_type, resource_id,
    job_id, metadata, created_at
  ) values (
    current_job.principal_id, 'worker', input_worker_id,
    'job.retry_scheduled', 'job', current_job.id::text, current_job.id,
    jsonb_build_object(
      'attempt', current_job.attempt, 'availableAt', retry_at,
      'errorClass', input_error_class, 'errorCode', input_error_code
    ),
    v_now
  );

  if current_job.type = 'chat.generation' then
    update public.chat_generations
    set status = 'queued', content = '', thinking = '', media = '[]'::jsonb,
        sequence = least(current_job.event_sequence, 2147483647)::integer,
        updated_at = v_now
    where id = current_job.id and user_id = current_job.principal_id;
    update public.messages
    set content = '', thinking = null, content_parts = '[]'::jsonb,
        thinking_parts = '[]'::jsonb, media_refs = '[]'::jsonb,
        status = 'streaming', updated_at = v_now
    where id = (current_job.subject->>'assistantMessageId')::uuid
      and conversation_id = (current_job.subject->>'conversationId')::uuid
      and user_id = current_job.principal_id and generation_id = current_job.id;
  elsif current_job.type = 'agent.task' then
    update public.agent_tasks
    set status = 'queued', error = input_error_code, updated_at = v_now
    where id = (current_job.subject->>'taskId')::uuid
      and user_id = current_job.principal_id
      and status not in ('completed', 'failed', 'cancelled');
  end if;

  return jsonb_build_object(
    'retried', true, 'reason', null, 'status', current_job.status,
    'availableAt', retry_at, 'eventSeq', current_job.event_sequence,
    'cancelRequested', false
  );
end;
$$;

revoke all on function public.retry_job(uuid,text,bigint,text,text,integer)
  from public, anon, authenticated;
grant execute on function public.retry_job(uuid,text,bigint,text,text,integer)
  to service_role;

create or replace function public.append_job_events(
  input_job_id uuid,
  input_worker_id text,
  input_lease_version bigint,
  input_events jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_job public.jobs%rowtype;
  v_now timestamptz := clock_timestamp();
  event_count integer;
  first_sequence bigint;
  keyed_count integer;
  existing_count integer;
  replay_from bigint;
  replay_to bigint;
begin
  if input_job_id is null or input_worker_id is null
     or length(input_worker_id) not between 1 and 256
     or input_lease_version is null or input_lease_version < 1
     or input_events is null or jsonb_typeof(input_events) <> 'array'
     or jsonb_array_length(input_events) not between 1 and 100
     or octet_length(input_events::text) > 1048576
     or exists (
       select 1
       from jsonb_array_elements(input_events) as item(event)
       where jsonb_typeof(item.event) <> 'object'
          or coalesce(item.event->>'kind', '') !~
            '^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)+$'
          or item.event->>'kind' in (
            'job.accepted', 'job.leased', 'job.checkpoint',
            'job.cancel_requested', 'job.terminal'
          )
          or (
            item.event ? 'payload'
            and jsonb_typeof(item.event->'payload') <> 'object'
          )
          or (
            item.event ? 'schemaVersion'
            and (
              jsonb_typeof(item.event->'schemaVersion') <> 'number'
              or item.event->>'schemaVersion' !~ '^[0-9]{1,4}$'
              or (item.event->>'schemaVersion')::integer not between 1 and 1000
            )
          )
          or (
            item.event ? 'idempotencyKey'
            and length(coalesce(item.event->>'idempotencyKey', '')) not between 1 and 256
          )
          or octet_length(coalesce(item.event->'payload', '{}'::jsonb)::text) > 1048576
     )
     or exists (
       select 1
       from jsonb_array_elements(input_events) as item(event)
       where item.event ? 'idempotencyKey'
       group by item.event->>'idempotencyKey'
       having count(*) > 1
     ) then
    raise exception 'invalid_job_events' using errcode = '22023';
  end if;
  event_count := jsonb_array_length(input_events);

  select * into current_job from public.jobs
  where id = input_job_id
  for update;
  if not found then
    return jsonb_build_object(
      'appended', false, 'reason', 'not_found', 'fromSeq', null,
      'toSeq', null, 'status', null, 'cancelRequested', false
    );
  end if;

  select count(*) filter (where event ? 'idempotencyKey')
  into keyed_count
  from jsonb_array_elements(input_events) as item(event);
  if keyed_count > 0 then
    select count(*), min(seq), max(seq)
    into existing_count, replay_from, replay_to
    from public.job_events
    where job_id = current_job.id
      and idempotency_key in (
        select event->>'idempotencyKey'
        from jsonb_array_elements(input_events) as item(event)
        where event ? 'idempotencyKey'
      );
    if existing_count > 0 then
      if keyed_count <> event_count
         or existing_count <> event_count
         or exists (
           select 1
           from jsonb_array_elements(input_events) as item(event)
           left join public.job_events as stored
             on stored.job_id = current_job.id
            and stored.idempotency_key = item.event->>'idempotencyKey'
           where stored.id is null
              or stored.kind <> item.event->>'kind'
              or stored.schema_version <> coalesce(
                (item.event->>'schemaVersion')::integer, 1
              )
              or stored.payload <> coalesce(item.event->'payload', '{}'::jsonb)
         ) then
        raise exception 'job_event_idempotency_conflict' using errcode = '23505';
      end if;
      return jsonb_build_object(
        'appended', true, 'replayed', true,
        'fromSeq', replay_from, 'toSeq', replay_to,
        'status', current_job.status,
        'cancelRequested', current_job.cancel_requested_at is not null
      );
    end if;
  end if;
  if current_job.status in ('completed', 'failed', 'cancelled') then
    return jsonb_build_object(
      'appended', false, 'reason', 'terminal', 'fromSeq', null,
      'toSeq', current_job.event_sequence, 'status', current_job.status,
      'cancelRequested', current_job.cancel_requested_at is not null
    );
  end if;
  if current_job.lease_owner is distinct from input_worker_id
     or current_job.lease_version <> input_lease_version
     or current_job.lease_expires_at is null
     or current_job.lease_expires_at <= v_now then
    return jsonb_build_object(
      'appended', false, 'reason', 'stale_fence', 'fromSeq', null,
      'toSeq', current_job.event_sequence, 'status', current_job.status,
      'cancelRequested', current_job.cancel_requested_at is not null
    );
  end if;

  first_sequence := current_job.event_sequence + 1;
  update public.jobs
  set event_sequence = event_sequence + event_count,
      updated_at = v_now
  where id = current_job.id
    and lease_owner = input_worker_id
    and lease_version = input_lease_version
    and lease_expires_at > v_now
  returning * into current_job;
  if not found then
    return jsonb_build_object(
      'appended', false, 'reason', 'stale_fence', 'fromSeq', null,
      'toSeq', null, 'status', null, 'cancelRequested', false
    );
  end if;

  insert into public.job_events(
    job_id, principal_id, seq, kind, idempotency_key, schema_version, payload,
    worker_id, lease_version, created_at
  )
  select current_job.id,
         current_job.principal_id,
         first_sequence + event.ordinality - 1,
         event.value->>'kind',
         nullif(event.value->>'idempotencyKey', ''),
         case
           when jsonb_typeof(event.value->'schemaVersion') = 'number'
             then greatest(1, least(1000, (event.value->>'schemaVersion')::integer))
           else 1
         end,
         coalesce(event.value->'payload', '{}'::jsonb),
         input_worker_id,
         input_lease_version,
         v_now
  from jsonb_array_elements(input_events) with ordinality
    as event(value, ordinality)
  order by event.ordinality;

  return jsonb_build_object(
    'appended', true,
    'replayed', false,
    'fromSeq', first_sequence,
    'toSeq', current_job.event_sequence,
    'status', current_job.status,
    'cancelRequested', current_job.cancel_requested_at is not null
  );
end;
$$;

revoke all on function public.append_job_events(uuid,text,bigint,jsonb)
  from public, anon, authenticated;
grant execute on function public.append_job_events(uuid,text,bigint,jsonb)
  to service_role;

create or replace function public.mirror_chat_job_progress(input_job public.jobs)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  progress_content text := coalesce(input_job.progress->>'content', '');
  progress_thinking text := coalesce(input_job.progress->>'thinking', '');
  progress_parts jsonb;
  progress_thinking_parts jsonb;
  progress_media_refs jsonb;
begin
  if input_job.type <> 'chat.generation' then return; end if;
  progress_parts := case
    when jsonb_typeof(input_job.progress->'contentParts') = 'array'
      then input_job.progress->'contentParts'
    when progress_content <> ''
      then jsonb_build_array(jsonb_build_object('type', 'text', 'text', progress_content))
    else '[]'::jsonb
  end;
  progress_thinking_parts := case
    when jsonb_typeof(input_job.progress->'thinkingParts') = 'array'
      then input_job.progress->'thinkingParts'
    when progress_thinking <> ''
      then jsonb_build_array(jsonb_build_object('type', 'text', 'text', progress_thinking))
    else '[]'::jsonb
  end;
  progress_media_refs := case
    when jsonb_typeof(input_job.progress->'mediaRefs') = 'array'
      then input_job.progress->'mediaRefs'
    else '[]'::jsonb
  end;

  update public.chat_generations
  set status = 'running',
      content = progress_content,
      thinking = progress_thinking,
      sequence = least(input_job.event_sequence, 2147483647)::integer,
      updated_at = input_job.updated_at
  where id = input_job.id
    and user_id = input_job.principal_id
    and status in ('queued', 'running');
  if not found then
    raise exception 'chat_generation_projection_missing' using errcode = '23503';
  end if;

  update public.messages
  set content = progress_content,
      thinking = nullif(progress_thinking, ''),
      content_parts = progress_parts,
      thinking_parts = progress_thinking_parts,
      media_refs = progress_media_refs,
      status = 'streaming',
      updated_at = input_job.updated_at
  where id = (input_job.subject->>'assistantMessageId')::uuid
    and user_id = input_job.principal_id
    and conversation_id = (input_job.subject->>'conversationId')::uuid
    and generation_id = input_job.id;
  if not found then
    raise exception 'chat_message_projection_missing' using errcode = '23503';
  end if;
end;
$$;

revoke all on function public.mirror_chat_job_progress(public.jobs)
  from public, anon, authenticated, service_role;

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
declare
  current_job public.jobs%rowtype;
  checkpoint_version bigint;
  v_now timestamptz := clock_timestamp();
  normalized_checkpoint jsonb := coalesce(input_checkpoint, '{}'::jsonb);
  normalized_progress jsonb := coalesce(input_progress, '{}'::jsonb);
begin
  if input_job_id is null or input_worker_id is null
     or length(input_worker_id) not between 1 and 256
     or input_lease_version is null or input_lease_version < 1
     or input_phase is null or input_phase !~ '^[a-z][a-z0-9_.-]{0,127}$'
     or input_status not in ('running', 'awaiting_input')
     or jsonb_typeof(normalized_checkpoint) <> 'object'
     or jsonb_typeof(normalized_progress) <> 'object'
     or octet_length(normalized_checkpoint::text) > 1048576
     or octet_length(normalized_progress::text) > 786432 then
    raise exception 'invalid_job_checkpoint' using errcode = '22023';
  end if;

  select * into current_job from public.jobs
  where id = input_job_id
  for update;
  if not found then
    return jsonb_build_object(
      'checkpointed', false, 'reason', 'not_found', 'status', null,
      'checkpointVersion', null, 'eventSeq', null, 'cancelRequested', false
    );
  end if;
  if current_job.status in ('completed', 'failed', 'cancelled') then
    return jsonb_build_object(
      'checkpointed', false, 'reason', 'terminal', 'status', current_job.status,
      'checkpointVersion', null, 'eventSeq', current_job.event_sequence,
      'cancelRequested', current_job.cancel_requested_at is not null
    );
  end if;
  if current_job.cancel_requested_at is not null then
    return jsonb_build_object(
      'checkpointed', false, 'reason', 'cancel_requested',
      'status', current_job.status, 'checkpointVersion', null,
      'eventSeq', current_job.event_sequence, 'cancelRequested', true
    );
  end if;
  if current_job.lease_owner is distinct from input_worker_id
     or current_job.lease_version <> input_lease_version
     or current_job.lease_expires_at is null
     or current_job.lease_expires_at <= v_now then
    return jsonb_build_object(
      'checkpointed', false, 'reason', 'stale_fence',
      'status', current_job.status, 'checkpointVersion', null,
      'eventSeq', current_job.event_sequence,
      'cancelRequested', current_job.cancel_requested_at is not null
    );
  end if;

  insert into public.job_checkpoints(
    job_id, principal_id, version, phase, checkpoint, progress, resumable,
    lease_version, created_at, updated_at
  ) values (
    current_job.id, current_job.principal_id, 1, input_phase,
    normalized_checkpoint, normalized_progress, coalesce(input_resumable, false),
    input_lease_version, v_now, v_now
  )
  on conflict (job_id) do update
  set version = public.job_checkpoints.version + 1,
      phase = excluded.phase,
      checkpoint = excluded.checkpoint,
      progress = excluded.progress,
      resumable = excluded.resumable,
      lease_version = excluded.lease_version,
      updated_at = excluded.updated_at
  returning version into checkpoint_version;

  update public.jobs
  set status = input_status,
      progress = normalized_progress,
      event_sequence = event_sequence + 1,
      updated_at = v_now
  where id = current_job.id
    and lease_owner = input_worker_id
    and lease_version = input_lease_version
    and lease_expires_at > v_now
  returning * into current_job;
  if not found then
    raise exception 'job_fence_changed_during_checkpoint' using errcode = '40001';
  end if;

  insert into public.job_events(
    job_id, principal_id, seq, kind, payload, worker_id, lease_version, created_at
  ) values (
    current_job.id, current_job.principal_id, current_job.event_sequence,
    'job.checkpoint',
    jsonb_build_object(
      'status', current_job.status, 'phase', input_phase,
      'checkpointVersion', checkpoint_version,
      'resumable', coalesce(input_resumable, false),
      'progress', normalized_progress
    ),
    input_worker_id, input_lease_version, v_now
  );

  perform public.mirror_chat_job_progress(current_job);
  if current_job.type = 'agent.task' then
    update public.agent_tasks
    set status = case
          when input_status = 'awaiting_input' then 'waiting_for_user'
          else 'running'
        end,
        updated_at = v_now
    where id = (current_job.subject->>'taskId')::uuid
      and user_id = current_job.principal_id
      and status not in ('completed', 'failed', 'cancelled');
  end if;

  return jsonb_build_object(
    'checkpointed', true,
    'status', current_job.status,
    'checkpointVersion', checkpoint_version,
    'eventSeq', current_job.event_sequence,
    'cancelRequested', false
  );
end;
$$;

revoke all on function public.checkpoint_job(
  uuid,text,bigint,text,jsonb,jsonb,boolean,text
) from public, anon, authenticated;
grant execute on function public.checkpoint_job(
  uuid,text,bigint,text,jsonb,jsonb,boolean,text
) to service_role;

create or replace function public.record_job_tool_effect(
  input_job_id uuid,
  input_worker_id text,
  input_lease_version bigint,
  input_tool_call_id text,
  input_tool_name text,
  input_args_hash text,
  input_effect_key text,
  input_status text,
  input_result_ref jsonb default null,
  input_replay_safe boolean default false,
  input_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_job public.jobs%rowtype;
  current_effect public.job_tool_effects%rowtype;
  v_now timestamptz := clock_timestamp();
  normalized_metadata jsonb := coalesce(input_metadata, '{}'::jsonb);
begin
  if input_job_id is null or input_worker_id is null
     or length(input_worker_id) not between 1 and 256
     or input_lease_version is null or input_lease_version < 1
     or input_tool_call_id is null or length(input_tool_call_id) not between 1 and 200
     or input_tool_name is null or length(input_tool_name) not between 1 and 200
     or input_args_hash is null or length(input_args_hash) not between 16 and 200
     or input_effect_key is null or length(input_effect_key) not between 1 and 300
     or input_status not in (
       'reserved', 'running', 'succeeded', 'failed', 'compensated', 'unknown'
     )
     or jsonb_typeof(normalized_metadata) <> 'object'
     or octet_length(normalized_metadata::text) > 262144
     or (input_result_ref is not null and octet_length(input_result_ref::text) > 262144) then
    raise exception 'invalid_job_tool_effect' using errcode = '22023';
  end if;

  select * into current_job from public.jobs
  where id = input_job_id
  for update;
  if not found
     or current_job.status in ('completed', 'failed', 'cancelled')
     or current_job.lease_owner is distinct from input_worker_id
     or current_job.lease_version <> input_lease_version
     or current_job.lease_expires_at is null
     or current_job.lease_expires_at <= v_now then
    return jsonb_build_object(
      'recorded', false, 'replayed', false, 'reason', 'stale_fence',
      'effectId', null, 'status', null
    );
  end if;
  if current_job.cancel_requested_at is not null
     and input_status in ('reserved', 'running') then
    return jsonb_build_object(
      'recorded', false, 'replayed', false, 'reason', 'cancel_requested',
      'effectId', null, 'status', null
    );
  end if;

  select * into current_effect
  from public.job_tool_effects
  where principal_id = current_job.principal_id and effect_key = input_effect_key
  for update;
  if found then
    if current_effect.job_id <> current_job.id
       or current_effect.tool_call_id <> input_tool_call_id
       or current_effect.tool_name <> input_tool_name
       or current_effect.args_hash <> input_args_hash then
      raise exception 'tool_effect_idempotency_conflict' using errcode = '23505';
    end if;
    if current_effect.status in ('succeeded', 'compensated') then
      return jsonb_build_object(
        'recorded', false, 'replayed', true, 'reason', 'terminal_effect',
        'effectId', current_effect.id, 'status', current_effect.status,
        'resultRef', current_effect.result_ref
      );
    end if;
    if not (
      input_status = current_effect.status
      or (current_effect.status = 'reserved' and input_status in ('running', 'failed', 'unknown'))
      or (current_effect.status = 'running' and input_status in ('succeeded', 'failed', 'unknown'))
      or (current_effect.status in ('failed', 'unknown') and input_status in (
        'running', 'succeeded', 'compensated'
      ))
    ) then
      raise exception 'invalid_tool_effect_transition' using errcode = '55000';
    end if;
    update public.job_tool_effects
    set status = input_status,
        result_ref = coalesce(input_result_ref, result_ref),
        replay_safe = replay_safe or coalesce(input_replay_safe, false),
        metadata = metadata || normalized_metadata,
        lease_version = input_lease_version,
        completed_at = case
          when input_status in ('succeeded', 'compensated') then v_now
          else completed_at
        end,
        updated_at = v_now
    where id = current_effect.id
    returning * into current_effect;
  else
    if input_status not in ('reserved', 'running') then
      raise exception 'tool_effect_must_be_reserved_first' using errcode = '55000';
    end if;
    insert into public.job_tool_effects(
      job_id, principal_id, tool_call_id, tool_name, args_hash, effect_key,
      status, replay_safe, result_ref, metadata, lease_version,
      created_at, updated_at
    ) values (
      current_job.id, current_job.principal_id, input_tool_call_id,
      input_tool_name, input_args_hash, input_effect_key, input_status,
      coalesce(input_replay_safe, false), input_result_ref, normalized_metadata,
      input_lease_version, v_now, v_now
    ) returning * into current_effect;
  end if;

  return jsonb_build_object(
    'recorded', true, 'replayed', false,
    'effectId', current_effect.id, 'status', current_effect.status,
    'resultRef', current_effect.result_ref
  );
end;
$$;

revoke all on function public.record_job_tool_effect(
  uuid,text,bigint,text,text,text,text,text,jsonb,boolean,jsonb
) from public, anon, authenticated;
grant execute on function public.record_job_tool_effect(
  uuid,text,bigint,text,text,text,text,text,jsonb,boolean,jsonb
) to service_role;

create or replace function public.finalize_job(
  input_job_id uuid,
  input_worker_id text,
  input_lease_version bigint,
  input_status text,
  input_result jsonb default '{}'::jsonb,
  input_error_class text default null,
  input_error_code text default null,
  input_ledger_entries jsonb default '[]'::jsonb,
  input_outbox jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_job public.jobs%rowtype;
  existing_ledger public.ledger_entries%rowtype;
  ledger_item jsonb;
  outbox_item jsonb;
  normalized_result jsonb := coalesce(input_result, '{}'::jsonb);
  normalized_ledger jsonb := coalesce(input_ledger_entries, '[]'::jsonb);
  normalized_outbox jsonb := coalesce(input_outbox, '[]'::jsonb);
  effective_status text;
  effective_error_class text;
  effective_error_code text;
  irreversible_committed boolean := coalesce(
    normalized_result->'irreversibleCommitted' = 'true'::jsonb,
    false
  );
  v_now timestamptz := clock_timestamp();
  ledger_weighted bigint;
  ledger_raw bigint;
  ledger_cost numeric(20, 8);
  ledger_direction text;
  outbox_index integer := 0;
  outbox_topic text;
  outbox_dedupe text;
begin
  if input_job_id is null or input_worker_id is null
     or length(input_worker_id) not between 1 and 256
     or input_lease_version is null or input_lease_version < 1
     or input_status not in ('completed', 'failed', 'cancelled')
     or octet_length(normalized_result::text) > 786432
     or jsonb_typeof(normalized_ledger) <> 'array'
     or jsonb_array_length(normalized_ledger) > 32
     or octet_length(normalized_ledger::text) > 1048576
     or jsonb_typeof(normalized_outbox) <> 'array'
     or jsonb_array_length(normalized_outbox) > 32
     or octet_length(normalized_outbox::text) > 1048576
     or (input_status = 'failed' and (
       input_error_class not in ('retryable', 'user', 'provider', 'policy', 'internal')
       or input_error_code is null or length(input_error_code) not between 1 and 200
     ))
     or exists (
       select 1 from jsonb_array_elements(normalized_ledger) as entry(item)
       where jsonb_typeof(entry.item) <> 'object'
          or length(coalesce(entry.item->>'idempotencyKey', '')) not between 1 and 300
          or length(coalesce(entry.item->>'reason', '')) not between 1 and 200
          or coalesce(entry.item->>'direction', 'debit') not in ('debit', 'credit')
          or coalesce(entry.item->>'weightedTokens', '0') !~ '^[0-9]{1,19}$'
          or coalesce(entry.item->>'rawTokens', '0') !~ '^[0-9]{1,19}$'
          or coalesce(entry.item->>'costEstimate', '0') !~ '^[0-9]{1,12}(\.[0-9]{1,8})?$'
          or coalesce(entry.item->>'currency', 'USD') !~ '^[A-Z]{3}$'
          or (
            entry.item ? 'metadata'
            and jsonb_typeof(entry.item->'metadata') <> 'object'
          )
     )
     or exists (
       select 1 from jsonb_array_elements(normalized_outbox) as entry(item)
       where jsonb_typeof(entry.item) <> 'object'
          or coalesce(entry.item->>'topic', entry.item->>'kind', '')
            !~ '^[a-z][a-z0-9_.-]{0,127}$'
          or (
            entry.item ? 'dedupeKey'
            and length(coalesce(entry.item->>'dedupeKey', '')) not between 1 and 300
          )
     ) then
    raise exception 'invalid_job_finalization' using errcode = '22023';
  end if;

  select * into current_job from public.jobs
  where id = input_job_id
  for update;
  if not found then
    return jsonb_build_object(
      'finalized', false, 'replayed', false, 'reason', 'not_found',
      'status', null, 'result', null, 'errorClass', null,
      'errorCode', null, 'eventSeq', null
    );
  end if;
  if current_job.status in ('completed', 'failed', 'cancelled') then
    return jsonb_build_object(
      'finalized', false, 'replayed', true, 'reason', 'terminal',
      'status', current_job.status, 'result', current_job.result,
      'errorClass', current_job.error_class, 'errorCode', current_job.error_code,
      'eventSeq', current_job.event_sequence
    );
  end if;
  if current_job.lease_owner is distinct from input_worker_id
     or current_job.lease_version <> input_lease_version
     or current_job.lease_expires_at is null
     or current_job.lease_expires_at <= v_now then
    return jsonb_build_object(
      'finalized', false, 'replayed', false, 'reason', 'stale_fence',
      'status', current_job.status, 'result', current_job.result,
      'errorClass', current_job.error_class, 'errorCode', current_job.error_code,
      'eventSeq', current_job.event_sequence
    );
  end if;

  effective_status := input_status;
  if current_job.cancel_requested_at is not null
     and input_status = 'completed'
     and not irreversible_committed then
    effective_status := 'cancelled';
  end if;
  if effective_status = 'failed' then
    effective_error_class := input_error_class;
    effective_error_code := input_error_code;
  else
    effective_error_class := null;
    effective_error_code := null;
  end if;

  -- A conflicting ledger idempotency key aborts the whole terminal transaction;
  -- it can never silently charge a different job or a different amount.
  for ledger_item in select value from jsonb_array_elements(normalized_ledger)
  loop
    ledger_weighted := coalesce((ledger_item->>'weightedTokens')::bigint, 0);
    ledger_raw := coalesce((ledger_item->>'rawTokens')::bigint, 0);
    ledger_cost := coalesce((ledger_item->>'costEstimate')::numeric, 0);
    ledger_direction := coalesce(ledger_item->>'direction', 'debit');
    select * into existing_ledger
    from public.ledger_entries
    where principal_id = current_job.principal_id
      and idempotency_key = ledger_item->>'idempotencyKey'
    for key share;
    if found and (
      existing_ledger.job_id <> current_job.id
      or existing_ledger.reason <> ledger_item->>'reason'
      or existing_ledger.direction <> ledger_direction
      or existing_ledger.weighted_tokens <> ledger_weighted
      or existing_ledger.raw_tokens <> ledger_raw
      or existing_ledger.cost_estimate <> ledger_cost
    ) then
      raise exception 'ledger_idempotency_conflict' using errcode = '23505';
    end if;
  end loop;

  update public.jobs
  set status = effective_status,
      result = normalized_result,
      error_class = effective_error_class,
      error_code = effective_error_code,
      event_sequence = event_sequence + 1,
      lease_owner = null,
      lease_expires_at = null,
      terminal_at = v_now,
      updated_at = v_now
  where id = current_job.id
    and lease_owner = input_worker_id
    and lease_version = input_lease_version
    and lease_expires_at > v_now
  returning * into current_job;
  if not found then
    raise exception 'job_fence_changed_during_finalize' using errcode = '40001';
  end if;

  insert into public.job_events(
    job_id, principal_id, seq, kind, payload, worker_id, lease_version, created_at
  ) values (
    current_job.id, current_job.principal_id, current_job.event_sequence,
    'job.terminal',
    jsonb_build_object(
      'status', current_job.status, 'result', current_job.result,
      'errorClass', current_job.error_class, 'errorCode', current_job.error_code,
      'retryable', current_job.error_class in ('retryable', 'provider')
    ),
    input_worker_id, input_lease_version, v_now
  );

  for ledger_item in select value from jsonb_array_elements(normalized_ledger)
  loop
    insert into public.ledger_entries(
      principal_id, job_id, idempotency_key, reason, direction,
      weighted_tokens, raw_tokens, model, provider, cost_estimate,
      currency, metadata, created_at
    ) values (
      current_job.principal_id,
      current_job.id,
      ledger_item->>'idempotencyKey',
      ledger_item->>'reason',
      coalesce(ledger_item->>'direction', 'debit'),
      coalesce((ledger_item->>'weightedTokens')::bigint, 0),
      coalesce((ledger_item->>'rawTokens')::bigint, 0),
      nullif(ledger_item->>'model', ''),
      nullif(ledger_item->>'provider', ''),
      coalesce((ledger_item->>'costEstimate')::numeric, 0),
      coalesce(ledger_item->>'currency', 'USD'),
      coalesce(ledger_item->'metadata', '{}'::jsonb),
      v_now
    ) on conflict (principal_id, idempotency_key) do nothing;
  end loop;

  insert into public.job_outbox(
    job_id, principal_id, topic, dedupe_key, payload, created_at, updated_at
  ) values (
    current_job.id, current_job.principal_id, 'jobs.terminal',
    current_job.id::text || ':terminal',
    jsonb_build_object(
      'jobId', current_job.id, 'type', current_job.type,
      'status', current_job.status, 'eventSeq', current_job.event_sequence
    ),
    v_now, v_now
  ) on conflict (job_id, dedupe_key) do nothing;

  for outbox_item in select value from jsonb_array_elements(normalized_outbox)
  loop
    outbox_index := outbox_index + 1;
    outbox_topic := coalesce(outbox_item->>'topic', outbox_item->>'kind');
    outbox_dedupe := coalesce(
      nullif(outbox_item->>'dedupeKey', ''),
      current_job.id::text || ':outbox:' || outbox_index::text || ':' || outbox_topic
    );
    insert into public.job_outbox(
      job_id, principal_id, topic, dedupe_key, payload, available_at,
      created_at, updated_at
    ) values (
      current_job.id,
      current_job.principal_id,
      outbox_topic,
      outbox_dedupe,
      coalesce(outbox_item->'payload', '{}'::jsonb),
      case
        when coalesce(outbox_item->>'delaySeconds', '0') ~ '^[0-9]{1,6}$'
          then v_now + make_interval(
            secs => least((outbox_item->>'delaySeconds')::integer, 604800)
          )
        else v_now
      end,
      v_now,
      v_now
    ) on conflict (job_id, dedupe_key) do nothing;
  end loop;

  insert into public.audit_log(
    principal_id, actor_type, actor_id, action, resource_type, resource_id,
    job_id, metadata, created_at
  ) values (
    current_job.principal_id, 'worker', input_worker_id,
    'job.finalized', 'job', current_job.id::text, current_job.id,
    jsonb_build_object(
      'status', current_job.status, 'leaseVersion', input_lease_version,
      'eventSeq', current_job.event_sequence
    ),
    v_now
  );

  perform public.mirror_chat_job_terminal(current_job);
  if current_job.type = 'agent.task' then
    update public.agent_tasks
    set status = case
          when current_job.status = 'completed'
               and current_job.result->>'taskStatus' in ('waiting_for_user', 'completed')
            then current_job.result->>'taskStatus'
          else current_job.status
        end,
        error = current_job.error_code,
        updated_at = v_now,
        finished_at = case
          when current_job.status = 'completed'
               and current_job.result->>'taskStatus' = 'waiting_for_user'
            then null
          else v_now
        end
    where id = (current_job.subject->>'taskId')::uuid
      and user_id = current_job.principal_id
      and status not in ('completed', 'failed', 'cancelled');
    update public.code_messages
    set content = case
          when length(coalesce(current_job.result->>'content', '')) > 0
            then current_job.result->>'content'
          when current_job.status = 'cancelled' and content = '' then '已停止。'
          when current_job.status = 'failed' and content = ''
            then '任务执行失败，请稍后重试。'
          else content
        end,
        meta = coalesce(meta, '{}'::jsonb) || jsonb_build_object(
          'taskId', current_job.subject->>'taskId',
          'jobId', current_job.id,
          'status', case
            when current_job.status = 'completed'
                 and current_job.result->>'taskStatus' in ('waiting_for_user', 'completed')
              then current_job.result->>'taskStatus'
            else current_job.status
          end,
          'errorCode', current_job.error_code,
          'progress', coalesce(current_job.result->'progress', '{}'::jsonb)
        )
    where id = (current_job.subject->>'responseId')::uuid
      and session_id = (current_job.subject->>'sessionId')::uuid
      and user_id = current_job.principal_id
      and role = 'assistant';
    if not found then
      raise exception 'agent_message_projection_missing' using errcode = '23503';
    end if;
  elsif current_job.type = 'chat.title'
        and current_job.status = 'completed'
        and length(coalesce(current_job.result->>'title', '')) between 1 and 200 then
    update public.conversations
    set title = current_job.result->>'title', updated_at = v_now
    where id = (current_job.subject->>'conversationId')::uuid
      and user_id = current_job.principal_id;
  end if;

  return jsonb_build_object(
    'finalized', true, 'replayed', false,
    'status', current_job.status, 'result', current_job.result,
    'errorClass', current_job.error_class, 'errorCode', current_job.error_code,
    'eventSeq', current_job.event_sequence
  );
end;
$$;

revoke all on function public.finalize_job(
  uuid,text,bigint,text,jsonb,text,text,jsonb,jsonb
) from public, anon, authenticated;
grant execute on function public.finalize_job(
  uuid,text,bigint,text,jsonb,text,text,jsonb,jsonb
) to service_role;

create or replace function public.cancel_job(
  input_job_id uuid,
  input_principal_id uuid,
  input_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_job public.jobs%rowtype;
  v_now timestamptz := clock_timestamp();
  terminal_now boolean;
begin
  if input_job_id is null or input_principal_id is null
     or (input_reason is not null and length(input_reason) > 500) then
    raise exception 'invalid_job_cancellation' using errcode = '22023';
  end if;

  select * into current_job from public.jobs
  where id = input_job_id and principal_id = input_principal_id
  for update;
  if not found then
    return jsonb_build_object(
      'accepted', false, 'replayed', false, 'reason', 'not_found',
      'status', null, 'result', null, 'eventSeq', null
    );
  end if;
  if current_job.status in ('completed', 'failed', 'cancelled') then
    return jsonb_build_object(
      'accepted', current_job.status = 'cancelled',
      'replayed', true, 'reason', 'terminal',
      'status', current_job.status, 'result', current_job.result,
      'eventSeq', current_job.event_sequence
    );
  end if;
  if current_job.cancel_requested_at is not null then
    return jsonb_build_object(
      'accepted', true, 'replayed', true, 'reason', 'already_requested',
      'status', current_job.status, 'result', current_job.result,
      'eventSeq', current_job.event_sequence
    );
  end if;

  terminal_now := current_job.status in ('queued', 'awaiting_input')
    or current_job.lease_expires_at is null
    or current_job.lease_expires_at <= v_now;

  if terminal_now then
    update public.jobs
    set status = 'cancelled',
        cancel_requested_at = v_now,
        cancel_reason = nullif(input_reason, ''),
        result = coalesce(result, '{}'::jsonb),
        error_class = null,
        error_code = null,
        event_sequence = event_sequence + 1,
        lease_owner = null,
        lease_expires_at = null,
        terminal_at = v_now,
        updated_at = v_now
    where id = current_job.id
    returning * into current_job;

    insert into public.job_events(
      job_id, principal_id, seq, kind, payload, created_at
    ) values (
      current_job.id, current_job.principal_id, current_job.event_sequence,
      'job.terminal',
      jsonb_build_object(
        'status', current_job.status, 'result', current_job.result,
        'errorClass', null, 'errorCode', null, 'retryable', false,
        'cancelReason', current_job.cancel_reason
      ),
      v_now
    );
    insert into public.job_outbox(
      job_id, principal_id, topic, dedupe_key, payload, created_at, updated_at
    ) values (
      current_job.id, current_job.principal_id, 'jobs.terminal',
      current_job.id::text || ':terminal',
      jsonb_build_object(
        'jobId', current_job.id, 'status', current_job.status,
        'eventSeq', current_job.event_sequence
      ),
      v_now, v_now
    ) on conflict (job_id, dedupe_key) do nothing;
    perform public.mirror_chat_job_terminal(current_job);
    if current_job.type = 'agent.task' then
      update public.agent_tasks
      set status = 'cancelled', updated_at = v_now, finished_at = v_now
      where id = (current_job.subject->>'taskId')::uuid
        and user_id = current_job.principal_id
        and status not in ('completed', 'failed', 'cancelled');
    end if;
  else
    update public.jobs
    set status = 'cancelling',
        cancel_requested_at = v_now,
        cancel_reason = nullif(input_reason, ''),
        event_sequence = event_sequence + 1,
        updated_at = v_now
    where id = current_job.id
    returning * into current_job;

    insert into public.job_events(
      job_id, principal_id, seq, kind, payload, created_at
    ) values (
      current_job.id, current_job.principal_id, current_job.event_sequence,
      'job.cancel_requested',
      jsonb_build_object(
        'status', current_job.status, 'reason', current_job.cancel_reason
      ),
      v_now
    );
    insert into public.job_outbox(
      job_id, principal_id, topic, dedupe_key, payload, created_at, updated_at
    ) values (
      current_job.id, current_job.principal_id, 'jobs.cancel_requested',
      current_job.id::text || ':cancel:' || current_job.event_sequence::text,
      jsonb_build_object(
        'jobId', current_job.id, 'status', current_job.status,
        'eventSeq', current_job.event_sequence
      ),
      v_now, v_now
    ) on conflict (job_id, dedupe_key) do nothing;
  end if;

  insert into public.audit_log(
    principal_id, actor_type, actor_id, action, resource_type, resource_id,
    job_id, metadata, created_at
  ) values (
    current_job.principal_id, 'service', current_job.principal_id::text,
    'job.cancel_requested', 'job', current_job.id::text, current_job.id,
    jsonb_build_object(
      'status', current_job.status, 'terminal', terminal_now,
      'eventSeq', current_job.event_sequence
    ),
    v_now
  );

  return jsonb_build_object(
    'accepted', true, 'replayed', false,
    'status', current_job.status, 'result', current_job.result,
    'eventSeq', current_job.event_sequence
  );
end;
$$;

revoke all on function public.cancel_job(uuid,uuid,text)
  from public, anon, authenticated;
grant execute on function public.cancel_job(uuid,uuid,text)
  to service_role;

-- Oversized, sanitized command payloads are uploaded by the service before
-- enqueue and referenced from jobs.payload as a payloadRef descriptor. The
-- inline payload remains capped at 1 MiB so queue scans cannot become blob I/O.
insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values (
  'job-payloads', 'job-payloads', false, 50331648,
  array['application/json']::text[]
)
on conflict (id) do update
set public = false,
    file_size_limit = 50331648,
    allowed_mime_types = array['application/json']::text[];

drop policy if exists "job_payloads_read" on storage.objects;
drop policy if exists "job_payloads_insert" on storage.objects;
drop policy if exists "job_payloads_update" on storage.objects;
drop policy if exists "job_payloads_delete" on storage.objects;

create or replace function public.protect_job_payload_objects()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if current_user in ('authenticated', 'anon') then
    if tg_op = 'INSERT' then
      if new.bucket_id = 'job-payloads' then
        raise exception 'job_payload_service_owned' using errcode = '42501';
      end if;
    elsif tg_op = 'DELETE' then
      if old.bucket_id = 'job-payloads' then
        raise exception 'job_payload_service_owned' using errcode = '42501';
      end if;
    elsif old.bucket_id = 'job-payloads' or new.bucket_id = 'job-payloads' then
      raise exception 'job_payload_service_owned' using errcode = '42501';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists protect_job_payload_objects on storage.objects;
create trigger protect_job_payload_objects
before insert or update or delete on storage.objects
for each row execute function public.protect_job_payload_objects();

revoke all on function public.protect_job_payload_objects()
  from public, anon, authenticated, service_role;

create or replace function public.runtime_healthcheck_v4()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.runtime_healthcheck_v3()
    and to_regclass('public.jobs') is not null
    and to_regclass('public.job_events') is not null
    and to_regclass('public.job_outbox') is not null
    and to_regclass('public.job_checkpoints') is not null
    and to_regclass('public.job_tool_effects') is not null
    and to_regclass('public.ledger_entries') is not null
    and to_regclass('public.audit_log') is not null
    and to_regprocedure(
      'public.enqueue_job(uuid,text,text,uuid,text,jsonb,text,text,jsonb,jsonb,integer,integer,timestamptz)'
    ) is not null
    and to_regprocedure('public.claim_next_job(text,text[],integer)') is not null
    and to_regprocedure('public.renew_job_lease(uuid,text,bigint,integer)') is not null
    and to_regprocedure('public.retry_job(uuid,text,bigint,text,text,integer)') is not null
    and to_regprocedure('public.append_job_events(uuid,text,bigint,jsonb)') is not null
    and to_regprocedure(
      'public.checkpoint_job(uuid,text,bigint,text,jsonb,jsonb,boolean,text)'
    ) is not null
    and to_regprocedure(
      'public.record_job_tool_effect(uuid,text,bigint,text,text,text,text,text,jsonb,boolean,jsonb)'
    ) is not null
    and to_regprocedure(
      'public.finalize_job(uuid,text,bigint,text,jsonb,text,text,jsonb,jsonb)'
    ) is not null
    and to_regprocedure('public.cancel_job(uuid,uuid,text)') is not null
    and has_function_privilege(
      'service_role',
      'public.enqueue_job(uuid,text,text,uuid,text,jsonb,text,text,jsonb,jsonb,integer,integer,timestamptz)',
      'EXECUTE'
    )
    and has_function_privilege(
      'service_role', 'public.claim_next_job(text,text[],integer)', 'EXECUTE'
    )
    and has_function_privilege(
      'service_role', 'public.renew_job_lease(uuid,text,bigint,integer)', 'EXECUTE'
    )
    and has_function_privilege(
      'service_role', 'public.retry_job(uuid,text,bigint,text,text,integer)', 'EXECUTE'
    )
    and has_function_privilege(
      'service_role', 'public.append_job_events(uuid,text,bigint,jsonb)', 'EXECUTE'
    )
    and has_function_privilege(
      'service_role',
      'public.checkpoint_job(uuid,text,bigint,text,jsonb,jsonb,boolean,text)',
      'EXECUTE'
    )
    and has_function_privilege(
      'service_role',
      'public.record_job_tool_effect(uuid,text,bigint,text,text,text,text,text,jsonb,boolean,jsonb)',
      'EXECUTE'
    )
    and has_function_privilege(
      'service_role',
      'public.finalize_job(uuid,text,bigint,text,jsonb,text,text,jsonb,jsonb)',
      'EXECUTE'
    )
    and has_function_privilege(
      'service_role', 'public.cancel_job(uuid,uuid,text)', 'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'public.enqueue_job(uuid,text,text,uuid,text,jsonb,text,text,jsonb,jsonb,integer,integer,timestamptz)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated', 'public.claim_next_job(text,text[],integer)', 'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated', 'public.renew_job_lease(uuid,text,bigint,integer)', 'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated', 'public.retry_job(uuid,text,bigint,text,text,integer)', 'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated', 'public.append_job_events(uuid,text,bigint,jsonb)', 'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'public.checkpoint_job(uuid,text,bigint,text,jsonb,jsonb,boolean,text)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'public.record_job_tool_effect(uuid,text,bigint,text,text,text,text,text,jsonb,boolean,jsonb)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'public.finalize_job(uuid,text,bigint,text,jsonb,text,text,jsonb,jsonb)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated', 'public.cancel_job(uuid,uuid,text)', 'EXECUTE'
    )
    and not has_table_privilege('authenticated', 'public.jobs', 'INSERT')
    and not has_table_privilege('authenticated', 'public.jobs', 'UPDATE')
    and not has_table_privilege('authenticated', 'public.jobs', 'DELETE')
    and not has_table_privilege('authenticated', 'public.job_events', 'INSERT')
    and not has_table_privilege('authenticated', 'public.ledger_entries', 'INSERT')
    and exists (
      select 1 from pg_catalog.pg_class
      where oid = 'public.jobs'::regclass and relrowsecurity
    )
    and exists (
      select 1 from pg_catalog.pg_class
      where oid = 'public.job_events'::regclass and relrowsecurity
    )
    and exists (
      select 1 from pg_catalog.pg_trigger
      where tgrelid = 'public.jobs'::regclass
        and tgname = 'enforce_job_state_contract'
        and not tgisinternal and tgenabled <> 'D'
    )
    and exists (
      select 1 from pg_catalog.pg_trigger
      where tgrelid = 'public.messages'::regclass
        and tgname = 'enforce_message_sor_contract'
        and not tgisinternal and tgenabled <> 'D'
    )
    and exists (
      select 1 from pg_catalog.pg_trigger
      where tgrelid = 'storage.objects'::regclass
        and tgname = 'protect_job_payload_objects'
        and not tgisinternal and tgenabled <> 'D'
    )
    and exists (
      select 1 from storage.buckets
      where id = 'job-payloads' and public = false
        and file_size_limit = 50331648
    );
$$;

revoke all on function public.runtime_healthcheck_v4()
  from public, anon, authenticated;
grant execute on function public.runtime_healthcheck_v4()
  to service_role;

commit;
