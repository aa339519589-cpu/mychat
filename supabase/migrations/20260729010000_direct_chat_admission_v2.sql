-- Replace the obsolete chat-turn authority RPC and the non-atomic REST write
-- sequence with one narrow service-only admission transaction. The function
-- persists the conversation/messages and calls the canonical enqueue_job
-- contract in the same PostgreSQL transaction.
begin;

create or replace function public.admit_chat_turn_v2(
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
  input_max_attempts integer
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, auth, pg_temp
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_created boolean := false;
  v_images jsonb := input_user_images;
  v_result jsonb;
  v_message public.messages%rowtype;
begin
  if input_user_id is null or input_conversation_id is null
     or input_create_conversation is null or input_user_message_id is null
     or input_assistant_message_id is null or input_job_id is null
     or input_user_message_id = input_assistant_message_id
     or input_job_id in (input_user_message_id, input_assistant_message_id)
     or input_user_content is null or octet_length(input_user_content) > 1048576
     or length(coalesce(input_conversation_title, '')) not between 1 and 200
     or input_auth_class not in ('anonymous', 'registered')
     or length(coalesce(input_idempotency_key, '')) not between 1 and 256
     or coalesce(input_input_hash, '') !~ '^[0-9a-f]{64}$'
     or jsonb_typeof(coalesce(input_payload, '{}'::jsonb)) <> 'object'
     or octet_length(coalesce(input_payload, '{}'::jsonb)::text) > 1048576
     or jsonb_typeof(coalesce(input_budget, '{}'::jsonb)) <> 'object'
     or input_queue not in ('chat', 'media')
     or input_max_attempts not between 1 and 3
     or input_user_created_at is null
     or input_user_created_at < v_now - interval '30 days'
     or input_user_created_at > v_now + interval '10 minutes'
     or (v_images is not null and (
       jsonb_typeof(v_images) <> 'object'
       or octet_length(v_images::text) > 8388608
       or jsonb_typeof(coalesce(v_images->'refs', '[]'::jsonb)) <> 'array'
       or jsonb_array_length(coalesce(v_images->'refs', '[]'::jsonb)) > 8
     )) then
    raise exception 'invalid_direct_chat_admission_v2'
      using errcode = '22023';
  end if;
  if v_images is not null and exists (
    select 1 from jsonb_array_elements(v_images->'refs') as item
    where jsonb_typeof(item) <> 'string'
  ) then
    raise exception 'invalid_direct_chat_images_v2'
      using errcode = '22023';
  end if;

  if input_create_conversation then
    if input_project_id is not null and not exists (
      select 1 from public.projects
      where id = input_project_id and user_id = input_user_id
    ) then
      raise exception 'direct_chat_project_not_found'
        using errcode = '23503';
    end if;
    insert into public.conversations(
      id, user_id, title, project_id, created_at, updated_at
    ) values (
      input_conversation_id, input_user_id, input_conversation_title,
      input_project_id, v_now, v_now
    ) on conflict (id) do nothing;
    v_created := found;
  end if;

  perform 1 from public.conversations
  where id = input_conversation_id and user_id = input_user_id
  for update;
  if not found then
    raise exception 'direct_chat_conversation_not_found'
      using errcode = '23503';
  end if;

  insert into public.messages(
    id, conversation_id, user_id, role, content, images, thinking,
    status, created_at, updated_at
  ) values (
    input_user_message_id, input_conversation_id, input_user_id, 'user',
    input_user_content, v_images, null, 'terminal', input_user_created_at, v_now
  ) on conflict (id) do nothing;
  select * into v_message from public.messages
  where id = input_user_message_id for update;
  if not found or v_message.user_id <> input_user_id
     or v_message.conversation_id <> input_conversation_id
     or v_message.role <> 'user'
     or v_message.content is distinct from input_user_content
     or v_message.images is distinct from v_images
     or v_message.generation_id is not null then
    raise exception 'direct_chat_user_message_conflict'
      using errcode = '23505';
  end if;

  insert into public.messages(
    id, conversation_id, user_id, role, content, images, thinking,
    status, created_at, updated_at
  ) values (
    input_assistant_message_id, input_conversation_id, input_user_id,
    'assistant', '', null, null, 'draft', v_now, v_now
  ) on conflict (id) do nothing;
  select * into v_message from public.messages
  where id = input_assistant_message_id for update;
  if not found or v_message.user_id <> input_user_id
     or v_message.conversation_id <> input_conversation_id
     or v_message.role <> 'assistant'
     or (v_message.generation_id is not null
       and v_message.generation_id <> input_job_id) then
    raise exception 'direct_chat_assistant_message_conflict'
      using errcode = '23505';
  end if;

  v_result := public.enqueue_job(
    input_job_id => input_job_id,
    input_type => 'chat.generation',
    input_queue => input_queue,
    input_principal_id => input_user_id,
    input_auth_class => input_auth_class,
    input_subject => jsonb_build_object(
      'conversationId', input_conversation_id,
      'userMessageId', input_user_message_id,
      'assistantMessageId', input_assistant_message_id
    ),
    input_idempotency_key => input_idempotency_key,
    input_input_hash => input_input_hash,
    input_payload => input_payload,
    input_budget => input_budget,
    input_priority => 0,
    input_max_attempts => input_max_attempts,
    input_available_at => v_now
  );

  update public.conversations
  set updated_at = v_now
  where id = input_conversation_id and user_id = input_user_id;

  return v_result || jsonb_build_object(
    'conversationId', input_conversation_id,
    'conversationCreated', v_created,
    'userMessageId', input_user_message_id,
    'assistantMessageId', input_assistant_message_id
  );
end;
$$;

revoke all on function public.admit_chat_turn_v2(
  uuid,uuid,boolean,uuid,text,uuid,text,jsonb,timestamptz,uuid,uuid,
  text,text,text,jsonb,jsonb,text,integer
) from public, anon, authenticated, service_role;
grant execute on function public.admit_chat_turn_v2(
  uuid,uuid,boolean,uuid,text,uuid,text,jsonb,timestamptz,uuid,uuid,
  text,text,text,jsonb,jsonb,text,integer
) to service_role;

-- Historical migration files remain immutable, but the obsolete callable
-- authority is removed from the live schema.
drop function if exists public.enqueue_chat_turn_v1(
  uuid,uuid,boolean,uuid,text,uuid,text,jsonb,timestamptz,uuid,uuid,
  text,text,text,jsonb,jsonb,text,integer
);

create or replace function public.runtime_healthcheck_v16()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select public.runtime_healthcheck_v14()
    and to_regclass('public.job_stream_capacity_counters') is not null
    and to_regprocedure(
      'public.heartbeat_job_worker_v2(text,text,jsonb,timestamptz,boolean)'
    ) is not null
    and to_regprocedure(
      'public.read_job_worker_readiness_v3(text[],integer,text)'
    ) is not null
    and to_regprocedure(
      'public.admit_chat_turn_v2(uuid,uuid,boolean,uuid,text,uuid,text,jsonb,timestamptz,uuid,uuid,text,text,text,jsonb,jsonb,text,integer)'
    ) is not null
    and to_regprocedure(
      'public.enqueue_chat_turn_v1(uuid,uuid,boolean,uuid,text,uuid,text,jsonb,timestamptz,uuid,uuid,text,text,text,jsonb,jsonb,text,integer)'
    ) is null
    and to_regprocedure(
      'public.enqueue_chat_regeneration_v1(uuid,uuid,text,uuid,uuid,uuid,text,uuid,uuid,text,text,text,jsonb,jsonb,text,integer,text[])'
    ) is not null
    and exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'job_worker_heartbeats'
        and column_name = 'queue_capacities' and data_type = 'jsonb'
    )
    and exists (
      select 1 from pg_catalog.pg_trigger
      where tgrelid = 'public.job_stream_leases'::regclass
        and tgname = 'adjust_job_stream_capacity_counter'
        and tgenabled = 'O' and not tgisinternal
    )
    and exists (
      select 1 from pg_catalog.pg_trigger
      where tgrelid = 'public.job_outbox'::regclass
        and tgname = 'suppress_unconsumed_job_lifecycle_outbox'
        and tgenabled = 'O' and not tgisinternal
    )
    and has_function_privilege(
      'service_role',
      'public.heartbeat_job_worker_v2(text,text,jsonb,timestamptz,boolean)',
      'EXECUTE'
    )
    and has_function_privilege(
      'service_role',
      'public.read_job_worker_readiness_v3(text[],integer,text)',
      'EXECUTE'
    )
    and has_function_privilege(
      'service_role',
      'public.admit_chat_turn_v2(uuid,uuid,boolean,uuid,text,uuid,text,jsonb,timestamptz,uuid,uuid,text,text,text,jsonb,jsonb,text,integer)',
      'EXECUTE'
    )
    and has_function_privilege(
      'service_role',
      'public.enqueue_chat_regeneration_v1(uuid,uuid,text,uuid,uuid,uuid,text,uuid,uuid,text,text,text,jsonb,jsonb,text,integer,text[])',
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'public.admit_chat_turn_v2(uuid,uuid,boolean,uuid,text,uuid,text,jsonb,timestamptz,uuid,uuid,text,text,text,jsonb,jsonb,text,integer)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'public.admit_chat_turn_v2(uuid,uuid,boolean,uuid,text,uuid,text,jsonb,timestamptz,uuid,uuid,text,text,text,jsonb,jsonb,text,integer)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'public.enqueue_chat_regeneration_v1(uuid,uuid,text,uuid,uuid,uuid,text,uuid,uuid,text,text,text,jsonb,jsonb,text,integer,text[])',
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'public.enqueue_chat_regeneration_v1(uuid,uuid,text,uuid,uuid,uuid,text,uuid,uuid,text,text,text,jsonb,jsonb,text,integer,text[])',
      'EXECUTE'
    )
    and not has_table_privilege(
      'service_role', 'public.job_stream_capacity_counters',
      'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
    );
$$;

revoke all on function public.runtime_healthcheck_v16()
  from public, anon, authenticated, service_role;
grant execute on function public.runtime_healthcheck_v16() to service_role;

comment on function public.admit_chat_turn_v2(
  uuid,uuid,boolean,uuid,text,uuid,text,jsonb,timestamptz,uuid,uuid,
  text,text,text,jsonb,jsonb,text,integer
) is
  'Atomically persists one direct chat turn and admits its canonical durable Job.';
comment on function public.runtime_healthcheck_v16() is
  'Requires the direct chat admission v2 contract and rejects the obsolete turn RPC.';

commit;
