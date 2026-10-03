\set ON_ERROR_STOP on

reset role;
insert into auth.users(id) values ('a3900000-0000-4000-8000-000000000001')
on conflict (id) do nothing;
insert into public.profiles(user_id, balance, limit_5h, limit_week)
values ('a3900000-0000-4000-8000-000000000001', 10000000, 10000000, 10000000)
on conflict (user_id) do update set
  balance = excluded.balance,
  limit_5h = excluded.limit_5h,
  limit_week = excluded.limit_week;

set role service_role;
set request.jwt.claim.role = 'service_role';

do $$
begin
  if not public.verify_schema_contract_v8(
    8, 'fd39067a1157b2146d1cf3ceb0d16c3c977255265cee5970827105fb818c9523', 57
  ) then
    raise exception 'schema contract v8 did not verify';
  end if;

  perform 1;
end;
$$;

do $$
declare
  admitted jsonb;
  replayed jsonb;
  payload jsonb := jsonb_build_object(
    'schemaVersion', 2,
    'payloadHash', repeat('c', 64),
    'outputKind', 'text',
    'billingClass', 'platform',
    'command', jsonb_build_object(
      'schemaVersion', 1,
      'policyVersion', '2026-07-13',
      'tier', '绝句',
      'searchMode', 'off',
      'historyRetrieval', false,
      'memoryEnabled', false,
      'usingBalance', false,
      'outputKind', 'text',
      'requestedAt', clock_timestamp()
    )
  );
begin
  admitted := public.admit_chat_turn_v3(
    input_user_id => 'a3900000-0000-4000-8000-000000000001',
    input_conversation_id => 'a3901000-0000-4000-8000-000000000001',
    input_create_conversation => true,
    input_project_id => null,
    input_conversation_title => 'Memory disabled chat',
    input_user_message_id => 'a3902000-0000-4000-8000-000000000001',
    input_user_content => 'do not use saved memory',
    input_user_images => null,
    input_user_created_at => clock_timestamp(),
    input_assistant_message_id => 'a3902000-0000-4000-8000-000000000002',
    input_job_id => 'a3903000-0000-4000-8000-000000000001',
    input_auth_class => 'registered',
    input_idempotency_key => 'conversation-memory-control-first',
    input_input_hash => repeat('c', 64),
    input_payload => payload,
    input_budget => '{"wallTimeMs":600000,"tokenLimit":160000,"toolCallLimit":64}'::jsonb,
    input_queue => 'chat',
    input_max_attempts => 3,
    input_memory_enabled => false
  );

  if admitted->>'enqueued' <> 'true'
     or admitted->>'conversationCreated' <> 'true'
     or (select memory_enabled from public.conversations
         where id = 'a3901000-0000-4000-8000-000000000001') is distinct from false
     or not exists (
       select 1 from public.jobs as job
       where job.id = 'a3903000-0000-4000-8000-000000000001'
         and job.payload->'command'->>'memoryEnabled' = 'false'
     ) then
    raise exception 'new conversation memory choice was not persisted atomically: %', admitted;
  end if;

  replayed := public.admit_chat_turn_v3(
    input_user_id => 'a3900000-0000-4000-8000-000000000001',
    input_conversation_id => 'a3901000-0000-4000-8000-000000000001',
    input_create_conversation => true,
    input_project_id => null,
    input_conversation_title => 'Memory disabled chat',
    input_user_message_id => 'a3902000-0000-4000-8000-000000000001',
    input_user_content => 'do not use saved memory',
    input_user_images => null,
    input_user_created_at => clock_timestamp(),
    input_assistant_message_id => 'a3902000-0000-4000-8000-000000000002',
    input_job_id => 'a3903000-0000-4000-8000-000000000001',
    input_auth_class => 'registered',
    input_idempotency_key => 'conversation-memory-control-first',
    input_input_hash => repeat('c', 64),
    input_payload => (select job.payload from public.jobs as job
                      where job.id = 'a3903000-0000-4000-8000-000000000001'),
    input_budget => '{"wallTimeMs":600000,"tokenLimit":160000,"toolCallLimit":64}'::jsonb,
    input_queue => 'chat',
    input_max_attempts => 3,
    input_memory_enabled => false
  );
  if replayed->>'replayed' <> 'true'
     or (select memory_enabled from public.conversations
         where id = 'a3901000-0000-4000-8000-000000000001') is distinct from false then
    raise exception 'memory setting changed during idempotent replay: %', replayed;
  end if;
end;
$$;

reset role;
set request.jwt.claim.role = 'authenticated';
do $$
begin
  begin
    update public.conversations
    set memory_enabled = true
    where id = 'a3901000-0000-4000-8000-000000000001';
    raise exception 'memory setting changed after the first user message';
  exception when sqlstate '55000' then
    null;
  end;
end;
$$;
reset request.jwt.claim.role;
