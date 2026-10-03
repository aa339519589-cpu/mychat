begin;

set local lock_timeout = '5s';

set local statement_timeout = '90s';

do $$ begin if not public.verify_schema_contract_v5(5,'69e4973cfac2b9532f27b784257df991e09796c1bdf8a6872297806de0db4d74',51) then raise exception 'existing_v5_contract_invalid'; end if; end; $$;

-- 20261003010000_memory_topics.sql
-- Memory entries are grouped into editable topics, matching the mobile
-- settings experience. Existing rows remain visible in the General topic.

alter table public.memories
  add column if not exists topic text not null default 'General';

alter table public.project_memories
  add column if not exists topic text not null default 'General';

update public.memories
set topic = 'General'
where topic is null or btrim(topic) = '';

update public.project_memories
set topic = 'General'
where topic is null or btrim(topic) = '';

create index if not exists memories_user_topic_updated_idx
  on public.memories(user_id, topic, updated_at desc);

create index if not exists project_memories_user_project_topic_updated_idx
  on public.project_memories(user_id, project_id, topic, updated_at desc);



-- 20261003020000_schema_contract_attestation_v6.sql
-- Seal topic-based global and project memories on top of the v5 contract.

do $$
begin
  if not public.runtime_healthcheck_v16() then
    raise exception 'schema_contract_v6_requires_runtime_v16'
      using errcode = '55000';
  end if;

  if not public.verify_schema_contract_v5(
    5,
    '69e4973cfac2b9532f27b784257df991e09796c1bdf8a6872297806de0db4d74',
    51
  ) then
    raise exception 'schema_contract_v6_requires_v5_attestation'
      using errcode = '55000';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'memories'
      and column_name = 'topic' and is_nullable = 'NO'
  ) or not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'project_memories'
      and column_name = 'topic' and is_nullable = 'NO'
  ) then
    raise exception 'schema_contract_v6_requires_memory_topics'
      using errcode = '55000';
  end if;

  insert into public.schema_contract_attestations(
    contract_version, manifest_sha256, migration_count
  ) values (
    6,
    'c8a467941277a0688646bee708099765141701aa019107ec4de43caae94c0618',
    53
  ) on conflict (contract_version) do nothing;

  if not exists (
    select 1 from public.schema_contract_attestations
    where contract_version = 6
      and manifest_sha256 = 'c8a467941277a0688646bee708099765141701aa019107ec4de43caae94c0618'
      and migration_count = 53
  ) then
    raise exception 'schema_contract_v6_attestation_conflict'
      using errcode = '55000';
  end if;
end;
$$;

create or replace function public.verify_schema_contract_v6(
  input_contract_version integer,
  input_manifest_sha256 text,
  input_migration_count integer
)
returns boolean
language sql
stable
strict
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select public.runtime_healthcheck_v16()
    and public.verify_schema_contract_v5(
      5,
      '69e4973cfac2b9532f27b784257df991e09796c1bdf8a6872297806de0db4d74',
      51
    )
    and input_contract_version = 6
    and input_manifest_sha256 ~ '^[0-9a-f]{64}$'
    and input_migration_count = 53
    and exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'memories'
        and column_name = 'topic' and is_nullable = 'NO'
    )
    and exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'project_memories'
        and column_name = 'topic' and is_nullable = 'NO'
    )
    and exists (
      select 1 from public.schema_contract_attestations
      where contract_version = input_contract_version
        and manifest_sha256 = input_manifest_sha256
        and migration_count = input_migration_count
    )
    and has_function_privilege(
      'service_role',
      'public.verify_schema_contract_v6(integer,text,integer)', 'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'public.verify_schema_contract_v6(integer,text,integer)', 'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'public.verify_schema_contract_v6(integer,text,integer)', 'EXECUTE'
    );
$$;

revoke all on function public.verify_schema_contract_v6(integer,text,integer)
  from public, anon, authenticated, service_role;
grant execute on function public.verify_schema_contract_v6(integer,text,integer)
  to service_role;

comment on function public.verify_schema_contract_v6(integer,text,integer) is
  'Fails closed unless runtime v16, v5, and global/project memory topics are installed.';

create or replace function public.verify_schema_contract_v3(
  input_contract_version integer,
  input_manifest_sha256 text,
  input_migration_count integer
)
returns boolean
language sql
stable
strict
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select public.verify_schema_contract_v6(
    input_contract_version,
    input_manifest_sha256,
    input_migration_count
  );
$$;

revoke all on function public.verify_schema_contract_v3(integer,text,integer)
  from public, anon, authenticated, service_role;
grant execute on function public.verify_schema_contract_v3(integer,text,integer)
  to service_role;

comment on function public.verify_schema_contract_v3(integer,text,integer) is
  'Stable readiness entry point delegated to the exact current schema contract.';



-- 20261003030000_memory_sensitivity_and_reset.sql
-- Sensitive memories require explicit account consent; turning consent off
-- atomically removes those rows. Reset removes global and project memories.

alter table public.profiles
  add column if not exists sensitive_memory_enabled boolean not null default false;

alter table public.memories
  add column if not exists sensitive boolean not null default false;

alter table public.project_memories
  add column if not exists sensitive boolean not null default false;

create or replace function public.guard_sensitive_memory_preference()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if coalesce(new.sensitive_memory_enabled, false)
     and current_user not in ('postgres', 'service_role', 'supabase_admin') then
    raise exception 'sensitive_memory_setting_requires_server_route' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_sensitive_memory_preference_guard on public.profiles;
create trigger profiles_sensitive_memory_preference_guard
before insert or update on public.profiles
for each row execute function public.guard_sensitive_memory_preference();

create or replace function public.guard_sensitive_memory_write()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  allowed boolean := false;
begin
  if not new.sensitive then return new; end if;

  select sensitive_memory_enabled into allowed
  from public.profiles
  where user_id = new.user_id
  for share;

  if not coalesce(allowed, false) then
    raise exception 'sensitive_memory_consent_required' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists memories_sensitive_consent_guard on public.memories;
create trigger memories_sensitive_consent_guard
before insert or update of sensitive, user_id on public.memories
for each row execute function public.guard_sensitive_memory_write();

drop trigger if exists project_memories_sensitive_consent_guard on public.project_memories;
create trigger project_memories_sensitive_consent_guard
before insert or update of sensitive, user_id on public.project_memories
for each row execute function public.guard_sensitive_memory_write();

create or replace function public.set_user_sensitive_memory_enabled(
  input_user_id uuid,
  input_enabled boolean
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  removed integer := 0;
  affected integer := 0;
begin
  if input_user_id is null or input_enabled is null then
    raise exception 'invalid_sensitive_memory_setting' using errcode = '22023';
  end if;

  insert into public.profiles(user_id, sensitive_memory_enabled)
    values (input_user_id, input_enabled)
  on conflict (user_id) do update
    set sensitive_memory_enabled = excluded.sensitive_memory_enabled;

  if not input_enabled then
    delete from public.memories where user_id = input_user_id and sensitive;
    get diagnostics affected = row_count;
    removed := removed + affected;

    delete from public.project_memories where user_id = input_user_id and sensitive;
    get diagnostics affected = row_count;
    removed := removed + affected;
  end if;

  return removed;
end;
$$;

create or replace function public.reset_user_memories(input_user_id uuid)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  removed integer := 0;
  affected integer := 0;
begin
  if input_user_id is null then
    raise exception 'invalid_memory_reset_user' using errcode = '22023';
  end if;

  delete from public.memories where user_id = input_user_id;
  get diagnostics affected = row_count;
  removed := removed + affected;

  delete from public.project_memories where user_id = input_user_id;
  get diagnostics affected = row_count;
  removed := removed + affected;

  return removed;
end;
$$;

revoke all on function public.set_user_sensitive_memory_enabled(uuid, boolean)
  from public, anon, authenticated;
grant execute on function public.set_user_sensitive_memory_enabled(uuid, boolean)
  to service_role;

revoke all on function public.reset_user_memories(uuid)
  from public, anon, authenticated;
grant execute on function public.reset_user_memories(uuid)
  to service_role;

revoke all on function public.guard_sensitive_memory_preference()
  from public, anon, authenticated;
revoke all on function public.guard_sensitive_memory_write()
  from public, anon, authenticated;



-- 20261003040000_schema_contract_attestation_v7.sql
-- Seal sensitive-memory consent and account-scoped reset operations.

do $$
begin
  if not public.runtime_healthcheck_v16() then
    raise exception 'schema_contract_v7_requires_runtime_v16'
      using errcode = '55000';
  end if;

  if not public.verify_schema_contract_v6(
    6,
    'c8a467941277a0688646bee708099765141701aa019107ec4de43caae94c0618',
    53
  ) then
    raise exception 'schema_contract_v7_requires_v6_attestation'
      using errcode = '55000';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles'
      and column_name = 'sensitive_memory_enabled' and is_nullable = 'NO'
  ) or not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'memories'
      and column_name = 'sensitive' and is_nullable = 'NO'
  ) or not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'project_memories'
      and column_name = 'sensitive' and is_nullable = 'NO'
  ) then
    raise exception 'schema_contract_v7_requires_sensitive_memory_columns'
      using errcode = '55000';
  end if;

  if to_regprocedure('public.set_user_sensitive_memory_enabled(uuid,boolean)') is null
     or to_regprocedure('public.reset_user_memories(uuid)') is null
     or to_regprocedure('public.guard_sensitive_memory_write()') is null
     or to_regprocedure('public.guard_sensitive_memory_preference()') is null then
    raise exception 'schema_contract_v7_requires_memory_management_functions'
      using errcode = '55000';
  end if;

  insert into public.schema_contract_attestations(
    contract_version, manifest_sha256, migration_count
  ) values (
    7,
    '181ca92677d727d9b86cec2e5329bdd62158f3bd3f61f95900e853c42a0de224',
    55
  ) on conflict (contract_version) do nothing;

  if not exists (
    select 1 from public.schema_contract_attestations
    where contract_version = 7
      and manifest_sha256 = '181ca92677d727d9b86cec2e5329bdd62158f3bd3f61f95900e853c42a0de224'
      and migration_count = 55
  ) then
    raise exception 'schema_contract_v7_attestation_conflict'
      using errcode = '55000';
  end if;
end;
$$;

create or replace function public.verify_schema_contract_v7(
  input_contract_version integer,
  input_manifest_sha256 text,
  input_migration_count integer
)
returns boolean
language sql
stable
strict
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select public.runtime_healthcheck_v16()
    and public.verify_schema_contract_v6(
      6,
      'c8a467941277a0688646bee708099765141701aa019107ec4de43caae94c0618',
      53
    )
    and input_contract_version = 7
    and input_manifest_sha256 ~ '^[0-9a-f]{64}$'
    and input_migration_count = 55
    and exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'profiles'
        and column_name = 'sensitive_memory_enabled' and is_nullable = 'NO'
    )
    and exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'memories'
        and column_name = 'sensitive' and is_nullable = 'NO'
    )
    and exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'project_memories'
        and column_name = 'sensitive' and is_nullable = 'NO'
    )
    and to_regprocedure('public.set_user_sensitive_memory_enabled(uuid,boolean)') is not null
    and to_regprocedure('public.reset_user_memories(uuid)') is not null
    and has_function_privilege(
      'service_role',
      'public.set_user_sensitive_memory_enabled(uuid,boolean)', 'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'public.set_user_sensitive_memory_enabled(uuid,boolean)', 'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'public.set_user_sensitive_memory_enabled(uuid,boolean)', 'EXECUTE'
    )
    and has_function_privilege(
      'service_role', 'public.reset_user_memories(uuid)', 'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated', 'public.reset_user_memories(uuid)', 'EXECUTE'
    )
    and not has_function_privilege(
      'anon', 'public.reset_user_memories(uuid)', 'EXECUTE'
    )
    and has_function_privilege(
      'service_role',
      'public.verify_schema_contract_v7(integer,text,integer)', 'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'public.verify_schema_contract_v7(integer,text,integer)', 'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'public.verify_schema_contract_v7(integer,text,integer)', 'EXECUTE'
    )
    and exists (
      select 1 from public.schema_contract_attestations
      where contract_version = input_contract_version
        and manifest_sha256 = input_manifest_sha256
        and migration_count = input_migration_count
    );
$$;

revoke all on function public.verify_schema_contract_v7(integer,text,integer)
  from public, anon, authenticated, service_role;
grant execute on function public.verify_schema_contract_v7(integer,text,integer)
  to service_role;

comment on function public.verify_schema_contract_v7(integer,text,integer) is
  'Fails closed unless v6 topics, sensitive-memory controls, reset RPCs, and the exact v7 manifest are installed.';

create or replace function public.verify_schema_contract_v3(
  input_contract_version integer,
  input_manifest_sha256 text,
  input_migration_count integer
)
returns boolean
language sql
stable
strict
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select public.verify_schema_contract_v7(
    input_contract_version,
    input_manifest_sha256,
    input_migration_count
  );
$$;

revoke all on function public.verify_schema_contract_v3(integer,text,integer)
  from public, anon, authenticated, service_role;
grant execute on function public.verify_schema_contract_v3(integer,text,integer)
  to service_role;



-- 20261003050000_conversation_memory_control.sql
-- Make saved-memory use a server-authoritative, per-conversation choice.

alter table public.conversations
  add column if not exists memory_enabled boolean not null default true;

update public.conversations
set memory_enabled = true
where memory_enabled is null;

alter table public.conversations
  alter column memory_enabled set default true,
  alter column memory_enabled set not null;

create or replace function public.guard_conversation_memory_setting()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if new.memory_enabled is distinct from old.memory_enabled
     and coalesce(current_setting('request.jwt.claim.role', true), '') <> 'service_role'
     and exists (
       select 1 from public.messages
       where conversation_id = old.id and role = 'user'
     ) then
    raise exception 'conversation_memory_setting_locked'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_conversation_memory_setting()
  from public, anon, authenticated, service_role;

drop trigger if exists conversations_memory_setting_guard on public.conversations;
create trigger conversations_memory_setting_guard
before update of memory_enabled on public.conversations
for each row execute function public.guard_conversation_memory_setting();

-- Keep the v2 RPC stable for deployed clients. New clients call this wrapper;
-- the v2 transaction creates/adopts the conversation and job, then this
-- wrapper sets the per-chat preference before the transaction can commit.
create or replace function public.admit_chat_turn_v3(
  input_user_id uuid,
  input_conversation_id uuid,
  input_create_conversation boolean,
  input_project_id uuid,
  input_conversation_title text,
  input_user_message_id uuid,
  input_user_content text,
  input_user_images jsonb,
  input_user_created_at timestamptz,
  input_assistant_message_id uuid,
  input_job_id uuid,
  input_auth_class text,
  input_idempotency_key text,
  input_input_hash text,
  input_payload jsonb,
  input_budget jsonb,
  input_queue text,
  input_max_attempts integer,
  input_memory_enabled boolean
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, auth, pg_temp
as $$
declare
  v_result jsonb;
begin
  if input_memory_enabled is null then
    raise exception 'invalid_conversation_memory_setting'
      using errcode = '22023';
  end if;

  v_result := public.admit_chat_turn_v2(
    input_user_id => input_user_id,
    input_conversation_id => input_conversation_id,
    input_create_conversation => input_create_conversation,
    input_project_id => input_project_id,
    input_conversation_title => input_conversation_title,
    input_user_message_id => input_user_message_id,
    input_user_content => input_user_content,
    input_user_images => input_user_images,
    input_user_created_at => input_user_created_at,
    input_assistant_message_id => input_assistant_message_id,
    input_job_id => input_job_id,
    input_auth_class => input_auth_class,
    input_idempotency_key => input_idempotency_key,
    input_input_hash => input_input_hash,
    input_payload => input_payload,
    input_budget => input_budget,
    input_queue => input_queue,
    input_max_attempts => input_max_attempts
  );

  if input_create_conversation
     and v_result->>'conversationCreated' = 'true' then
    update public.conversations
    set memory_enabled = input_memory_enabled
    where id = input_conversation_id and user_id = input_user_id;
    if not found then
      raise exception 'direct_chat_conversation_not_found'
        using errcode = '23503';
    end if;
  end if;

  return v_result;
end;
$$;

revoke all on function public.admit_chat_turn_v3(
  uuid,uuid,boolean,uuid,text,uuid,text,jsonb,timestamptz,uuid,uuid,
  text,text,text,jsonb,jsonb,text,integer,boolean
) from public, anon, authenticated, service_role;
grant execute on function public.admit_chat_turn_v3(
  uuid,uuid,boolean,uuid,text,uuid,text,jsonb,timestamptz,uuid,uuid,
  text,text,text,jsonb,jsonb,text,integer,boolean
) to service_role;

comment on column public.conversations.memory_enabled is
  'Whether saved global and project memories may be used in this conversation; the account preference can still disable them globally.';
comment on function public.guard_conversation_memory_setting() is
  'Locks a per-conversation memory choice after the first user message unless the service-only admission RPC is completing that first atomic turn.';
comment on function public.admit_chat_turn_v3(
  uuid,uuid,boolean,uuid,text,uuid,text,jsonb,timestamptz,uuid,uuid,
  text,text,text,jsonb,jsonb,text,integer,boolean
) is
  'Atomically admits a durable chat turn and fixes saved-memory use when creating its conversation.';



-- 20261003060000_schema_contract_attestation_v8.sql
-- Seal the per-conversation saved-memory control and service-only admission.

do $$
begin
  if not public.verify_schema_contract_v7(
    7,
    '181ca92677d727d9b86cec2e5329bdd62158f3bd3f61f95900e853c42a0de224',
    55
  ) then
    raise exception 'schema_contract_v8_requires_v7_attestation'
      using errcode = '55000';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'conversations'
      and column_name = 'memory_enabled' and data_type = 'boolean'
      and is_nullable = 'NO'
  ) or to_regprocedure(
    'public.admit_chat_turn_v3(uuid,uuid,boolean,uuid,text,uuid,text,jsonb,timestamptz,uuid,uuid,text,text,text,jsonb,jsonb,text,integer,boolean)'
  ) is null or to_regprocedure(
    'public.guard_conversation_memory_setting()'
  ) is null then
    raise exception 'schema_contract_v8_requires_conversation_memory_control'
      using errcode = '55000';
  end if;

  insert into public.schema_contract_attestations(
    contract_version, manifest_sha256, migration_count
  ) values (
    8,
    'fd39067a1157b2146d1cf3ceb0d16c3c977255265cee5970827105fb818c9523',
    57
  ) on conflict (contract_version) do nothing;

  if not exists (
    select 1 from public.schema_contract_attestations
    where contract_version = 8
      and manifest_sha256 = 'fd39067a1157b2146d1cf3ceb0d16c3c977255265cee5970827105fb818c9523'
      and migration_count = 57
  ) then
    raise exception 'schema_contract_v8_attestation_conflict'
      using errcode = '55000';
  end if;
end;
$$;

create or replace function public.verify_schema_contract_v8(
  input_contract_version integer,
  input_manifest_sha256 text,
  input_migration_count integer
)
returns boolean
language sql
stable
strict
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select public.runtime_healthcheck_v16()
    and public.verify_schema_contract_v7(
      7,
      '181ca92677d727d9b86cec2e5329bdd62158f3bd3f61f95900e853c42a0de224',
      55
    )
    and input_contract_version = 8
    and input_manifest_sha256 ~ '^[0-9a-f]{64}$'
    and input_migration_count = 57
    and exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'conversations'
        and column_name = 'memory_enabled' and data_type = 'boolean'
        and is_nullable = 'NO'
    )
    and to_regprocedure(
      'public.admit_chat_turn_v3(uuid,uuid,boolean,uuid,text,uuid,text,jsonb,timestamptz,uuid,uuid,text,text,text,jsonb,jsonb,text,integer,boolean)'
    ) is not null
    and to_regprocedure('public.guard_conversation_memory_setting()') is not null
    and has_function_privilege(
      'service_role',
      'public.admit_chat_turn_v3(uuid,uuid,boolean,uuid,text,uuid,text,jsonb,timestamptz,uuid,uuid,text,text,text,jsonb,jsonb,text,integer,boolean)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'public.admit_chat_turn_v3(uuid,uuid,boolean,uuid,text,uuid,text,jsonb,timestamptz,uuid,uuid,text,text,text,jsonb,jsonb,text,integer,boolean)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'public.admit_chat_turn_v3(uuid,uuid,boolean,uuid,text,uuid,text,jsonb,timestamptz,uuid,uuid,text,text,text,jsonb,jsonb,text,integer,boolean)',
      'EXECUTE'
    )
    and has_function_privilege(
      'service_role', 'public.verify_schema_contract_v8(integer,text,integer)', 'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated', 'public.verify_schema_contract_v8(integer,text,integer)', 'EXECUTE'
    )
    and not has_function_privilege(
      'anon', 'public.verify_schema_contract_v8(integer,text,integer)', 'EXECUTE'
    )
    and exists (
      select 1 from public.schema_contract_attestations
      where contract_version = input_contract_version
        and manifest_sha256 = input_manifest_sha256
        and migration_count = input_migration_count
    );
$$;

revoke all on function public.verify_schema_contract_v8(integer,text,integer)
  from public, anon, authenticated, service_role;
grant execute on function public.verify_schema_contract_v8(integer,text,integer)
  to service_role;

comment on function public.verify_schema_contract_v8(integer,text,integer) is
  'Fails closed unless v7 memory safeguards and per-conversation memory controls are installed.';

create or replace function public.verify_schema_contract_v3(
  input_contract_version integer,
  input_manifest_sha256 text,
  input_migration_count integer
)
returns boolean
language sql
stable
strict
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select public.verify_schema_contract_v8(
    input_contract_version,
    input_manifest_sha256,
    input_migration_count
  );
$$;

revoke all on function public.verify_schema_contract_v3(integer,text,integer)
  from public, anon, authenticated, service_role;
grant execute on function public.verify_schema_contract_v3(integer,text,integer)
  to service_role;



-- 20261003070000_remote_mcp_connectors.sql
-- Store user-configured remote MCP connections. Credential ciphertext is
-- service-only; application routes and chat workers always scope by user_id.

create table if not exists public.mcp_connectors (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (length(name) between 1 and 80),
  server_url text not null check (length(server_url) between 9 and 2048),
  credential_ciphertext text,
  tools jsonb not null default '[]'::jsonb check (jsonb_typeof(tools) = 'array'),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.mcp_connectors enable row level security;
revoke all on table public.mcp_connectors from public, anon, authenticated;
grant select, insert, update, delete on table public.mcp_connectors to service_role;

create unique index if not exists mcp_connectors_user_name_unique
  on public.mcp_connectors(user_id, lower(name));
create index if not exists mcp_connectors_enabled_by_user
  on public.mcp_connectors(user_id, created_at)
  where enabled;

comment on table public.mcp_connectors is
  'User-owned remote MCP servers. Access tokens are authenticated ciphertext and the table is service-role only.';
comment on column public.mcp_connectors.credential_ciphertext is
  'Optional Bearer token sealed with AES-256-GCM and bound to owner, connector id, and server URL.';
comment on column public.mcp_connectors.tools is
  'Bounded, sanitized MCP tools/list snapshot used to build model function schemas; refresh on demand.';



-- 20261003080000_schema_contract_attestation_v9.sql
-- Seal authenticated, service-only remote MCP connector storage.

do $$
begin
  if not public.verify_schema_contract_v8(
    8,
    'fd39067a1157b2146d1cf3ceb0d16c3c977255265cee5970827105fb818c9523',
    57
  ) then
    raise exception 'schema_contract_v9_requires_v8_attestation'
      using errcode = '55000';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'mcp_connectors'
      and column_name = 'credential_ciphertext' and data_type = 'text'
      and is_nullable = 'YES'
  ) or not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'mcp_connectors'
      and column_name = 'tools' and data_type = 'jsonb'
      and is_nullable = 'NO'
  ) or not coalesce((
    select relrowsecurity from pg_class
    where oid = 'public.mcp_connectors'::regclass
  ), false) then
    raise exception 'schema_contract_v9_requires_remote_mcp_connector_storage'
      using errcode = '55000';
  end if;

  if has_table_privilege('anon', 'public.mcp_connectors', 'SELECT')
     or has_table_privilege('authenticated', 'public.mcp_connectors', 'SELECT')
     or not has_table_privilege('service_role', 'public.mcp_connectors', 'SELECT')
     or not has_table_privilege('service_role', 'public.mcp_connectors', 'INSERT')
     or not has_table_privilege('service_role', 'public.mcp_connectors', 'UPDATE')
     or not has_table_privilege('service_role', 'public.mcp_connectors', 'DELETE') then
    raise exception 'schema_contract_v9_requires_service_only_connector_access'
      using errcode = '55000';
  end if;

  insert into public.schema_contract_attestations(
    contract_version, manifest_sha256, migration_count
  ) values (
    9,
    '2692c458d54feeaa330fb2e33ba2bda4429efc0104a5e78eea1b3df131bee97d',
    59
  ) on conflict (contract_version) do nothing;

  if not exists (
    select 1 from public.schema_contract_attestations
    where contract_version = 9
      and manifest_sha256 = '2692c458d54feeaa330fb2e33ba2bda4429efc0104a5e78eea1b3df131bee97d'
      and migration_count = 59
  ) then
    raise exception 'schema_contract_v9_attestation_conflict'
      using errcode = '55000';
  end if;
end;
$$;

create or replace function public.verify_schema_contract_v9(
  input_contract_version integer,
  input_manifest_sha256 text,
  input_migration_count integer
)
returns boolean
language sql
stable
strict
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select public.verify_schema_contract_v8(
      8,
      'fd39067a1157b2146d1cf3ceb0d16c3c977255265cee5970827105fb818c9523',
      57
    )
    and input_contract_version = 9
    and input_manifest_sha256 = '2692c458d54feeaa330fb2e33ba2bda4429efc0104a5e78eea1b3df131bee97d'
    and input_migration_count = 59
    and exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'mcp_connectors'
        and column_name = 'credential_ciphertext' and data_type = 'text'
        and is_nullable = 'YES'
    )
    and exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'mcp_connectors'
        and column_name = 'tools' and data_type = 'jsonb'
        and is_nullable = 'NO'
    )
    and coalesce((
      select relrowsecurity from pg_class
      where oid = 'public.mcp_connectors'::regclass
    ), false)
    and has_table_privilege('service_role', 'public.mcp_connectors', 'SELECT')
    and has_table_privilege('service_role', 'public.mcp_connectors', 'INSERT')
    and has_table_privilege('service_role', 'public.mcp_connectors', 'UPDATE')
    and has_table_privilege('service_role', 'public.mcp_connectors', 'DELETE')
    and not has_table_privilege('anon', 'public.mcp_connectors', 'SELECT')
    and not has_table_privilege('authenticated', 'public.mcp_connectors', 'SELECT')
    and has_function_privilege('service_role', 'public.verify_schema_contract_v9(integer,text,integer)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.verify_schema_contract_v9(integer,text,integer)', 'EXECUTE')
    and not has_function_privilege('anon', 'public.verify_schema_contract_v9(integer,text,integer)', 'EXECUTE')
    and exists (
      select 1 from public.schema_contract_attestations
      where contract_version = input_contract_version
        and manifest_sha256 = input_manifest_sha256
        and migration_count = input_migration_count
    );
$$;

revoke all on function public.verify_schema_contract_v9(integer,text,integer)
  from public, anon, authenticated, service_role;
grant execute on function public.verify_schema_contract_v9(integer,text,integer)
  to service_role;

comment on function public.verify_schema_contract_v9(integer,text,integer) is
  'Fails closed unless the v8 memory protections and service-only remote MCP connector storage are installed.';

create or replace function public.verify_schema_contract_v3(
  input_contract_version integer,
  input_manifest_sha256 text,
  input_migration_count integer
)
returns boolean
language sql
stable
strict
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select public.verify_schema_contract_v9(
    input_contract_version,
    input_manifest_sha256,
    input_migration_count
  );
$$;

revoke all on function public.verify_schema_contract_v3(integer,text,integer)
  from public, anon, authenticated, service_role;
grant execute on function public.verify_schema_contract_v3(integer,text,integer)
  to service_role;



-- 20261003090000_connector_oauth_lifecycle.sql

alter table public.mcp_connectors
  add column if not exists auth_type text not null default 'none' check (auth_type in ('none','bearer','oauth')),
  add column if not exists oauth_status text not null default 'connected' check (oauth_status in ('pending','connected','reauth_required')),
  add column if not exists oauth_refresh_lease uuid,
  add column if not exists oauth_refresh_until timestamptz;
update public.mcp_connectors set auth_type = 'bearer'
  where auth_type = 'none' and credential_ciphertext is not null;
create unique index if not exists mcp_connectors_id_owner_unique on public.mcp_connectors(id, user_id);

create table if not exists public.mcp_oauth_sessions (
  state_hash text primary key check (state_hash ~ '^[a-f0-9]{64}$'),
  user_id uuid not null references auth.users(id) on delete cascade,
  connector_id uuid not null,
  server_url text not null,
  secret_ciphertext text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  foreign key (connector_id,user_id) references public.mcp_connectors(id,user_id) on delete cascade
);
alter table public.mcp_oauth_sessions enable row level security;
revoke all on public.mcp_oauth_sessions from public, anon, authenticated;
grant select, insert, update, delete on public.mcp_oauth_sessions to service_role;
create index if not exists mcp_oauth_sessions_expiry on public.mcp_oauth_sessions(expires_at);

create or replace function public.claim_connector_oauth_refresh(input_user_id uuid, input_connector_id uuid, input_lease uuid)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare saved text;
begin
  if input_user_id is null or input_connector_id is null or input_lease is null then
    raise exception 'invalid_oauth_refresh_identity' using errcode='22023';
  end if;
  update public.mcp_connectors
    set oauth_refresh_lease=input_lease, oauth_refresh_until=now()+interval '60 seconds'
    where id=input_connector_id and user_id=input_user_id and enabled and auth_type='oauth'
      and oauth_status='connected' and (oauth_refresh_until is null or oauth_refresh_until < now())
    returning credential_ciphertext into saved;
  if not found then return null; end if;
  return jsonb_build_object('ciphertext',saved);
end;
$$;
revoke all on function public.claim_connector_oauth_refresh(uuid,uuid,uuid) from public, anon, authenticated;
grant execute on function public.claim_connector_oauth_refresh(uuid,uuid,uuid) to service_role;

-- Ordinary profile edits must still work after sensitive memory is enabled.
-- Changing consent in either direction remains a server-only operation.
create or replace function public.guard_sensitive_memory_preference()
returns trigger language plpgsql set search_path = pg_catalog, public as $$
begin
  if current_user in ('postgres','service_role','supabase_admin') then return new; end if;
  if (tg_op='INSERT' and coalesce(new.sensitive_memory_enabled,false))
     or (tg_op='UPDATE' and new.sensitive_memory_enabled is distinct from old.sensitive_memory_enabled) then
    raise exception 'sensitive_memory_setting_requires_server_route' using errcode='42501';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_sensitive_memory_preference() from public, anon, authenticated;


-- 20261003100000_schema_contract_attestation_v10.sql

create or replace function public.verify_schema_contract_v10(
  input_contract_version integer, input_manifest_sha256 text, input_migration_count integer
) returns boolean language sql stable strict security definer set search_path = pg_catalog, public, pg_temp as $$
select public.verify_schema_contract_v9(9,'2692c458d54feeaa330fb2e33ba2bda4429efc0104a5e78eea1b3df131bee97d',59)
  and input_contract_version=10 and input_manifest_sha256='b8c2500aee3ef8059d6119387b9e08106175f407488a003ec982103964739a35' and input_migration_count=61
  and has_function_privilege('service_role','public.verify_schema_contract_v10(integer,text,integer)','EXECUTE')
  and not has_function_privilege('authenticated','public.verify_schema_contract_v10(integer,text,integer)','EXECUTE')
  and not has_function_privilege('anon','public.verify_schema_contract_v10(integer,text,integer)','EXECUTE')
  and to_regprocedure('public.claim_connector_oauth_refresh(uuid,uuid,uuid)') is not null
  and coalesce((select relrowsecurity from pg_class where oid='public.mcp_oauth_sessions'::regclass),false)
  and not has_table_privilege('anon','public.mcp_oauth_sessions','SELECT')
  and not has_table_privilege('authenticated','public.mcp_oauth_sessions','SELECT')
  and has_table_privilege('service_role','public.mcp_oauth_sessions','SELECT,INSERT,DELETE')
  and not has_function_privilege('authenticated','public.claim_connector_oauth_refresh(uuid,uuid,uuid)','EXECUTE')
  and has_function_privilege('service_role','public.claim_connector_oauth_refresh(uuid,uuid,uuid)','EXECUTE')
  and exists (select 1 from information_schema.columns where table_schema='public' and table_name='mcp_connectors' and column_name='auth_type')
  and exists (select 1 from public.schema_contract_attestations where contract_version=input_contract_version
    and manifest_sha256=input_manifest_sha256 and migration_count=input_migration_count);
$$;
revoke all on function public.verify_schema_contract_v10(integer,text,integer) from public,anon,authenticated;
grant execute on function public.verify_schema_contract_v10(integer,text,integer) to service_role;

insert into public.schema_contract_attestations(contract_version,manifest_sha256,migration_count)
  values (10,'b8c2500aee3ef8059d6119387b9e08106175f407488a003ec982103964739a35',61) on conflict (contract_version) do nothing;
do $$ begin
  if not public.verify_schema_contract_v10(10,'b8c2500aee3ef8059d6119387b9e08106175f407488a003ec982103964739a35',61) then
    raise exception 'schema_contract_v10_oauth_lifecycle_invalid' using errcode='55000';
  end if;
end; $$;

-- These additive migrations retain readiness for the deployed release while
-- the new application is building, and permit a code rollback without data loss.
create or replace function public.verify_schema_contract_v3(input_contract_version integer,input_manifest_sha256 text,input_migration_count integer)
returns boolean language sql stable strict security definer set search_path = pg_catalog, public, pg_temp as $$
select case input_contract_version
  when 4 then public.verify_schema_contract_v4(input_contract_version,input_manifest_sha256,input_migration_count)
  when 5 then public.verify_schema_contract_v5(input_contract_version,input_manifest_sha256,input_migration_count)
  when 6 then public.verify_schema_contract_v6(input_contract_version,input_manifest_sha256,input_migration_count)
  when 7 then public.verify_schema_contract_v7(input_contract_version,input_manifest_sha256,input_migration_count)
  when 8 then public.verify_schema_contract_v8(input_contract_version,input_manifest_sha256,input_migration_count)
  when 9 then public.verify_schema_contract_v9(input_contract_version,input_manifest_sha256,input_migration_count)
  when 10 then public.verify_schema_contract_v10(input_contract_version,input_manifest_sha256,input_migration_count)
  else false end;
$$;
revoke all on function public.verify_schema_contract_v3(integer,text,integer) from public,anon,authenticated;
grant execute on function public.verify_schema_contract_v3(integer,text,integer) to service_role;


do $$ begin if not public.verify_schema_contract_v3(10,'b8c2500aee3ef8059d6119387b9e08106175f407488a003ec982103964739a35',61) or not public.verify_schema_contract_v3(5,'69e4973cfac2b9532f27b784257df991e09796c1bdf8a6872297806de0db4d74',51) then raise exception 'migration_readiness_or_rollback_contract_failed'; end if; end; $$;

commit;

select contract_version,manifest_sha256,migration_count from public.schema_contract_attestations where contract_version=10;