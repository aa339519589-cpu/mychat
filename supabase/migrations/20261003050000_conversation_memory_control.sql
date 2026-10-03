-- Make saved-memory use a server-authoritative, per-conversation choice.
begin;

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

commit;
