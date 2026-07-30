\set ON_ERROR_STOP on

reset role;
insert into auth.users(id) values
  ('a2900000-0000-4000-8000-000000000001'),
  ('a2900000-0000-4000-8000-000000000002')
on conflict (id) do nothing;
insert into public.profiles(user_id, balance, limit_5h, limit_week) values
  ('a2900000-0000-4000-8000-000000000001', 10000000, 10000000, 10000000),
  ('a2900000-0000-4000-8000-000000000002', 10000000, 10000000, 10000000)
on conflict (user_id) do update set
  balance = excluded.balance,
  limit_5h = excluded.limit_5h,
  limit_week = excluded.limit_week;

set role service_role;
set request.jwt.claim.role = 'service_role';

do $$
declare
  admitted jsonb;
  replayed jsonb;
begin
  if to_regprocedure(
    'public.enqueue_chat_turn_v1(uuid,uuid,boolean,uuid,text,uuid,text,jsonb,timestamptz,uuid,uuid,text,text,text,jsonb,jsonb,text,integer)'
  ) is not null then
    raise exception 'obsolete chat turn RPC still exists';
  end if;
  if to_regprocedure(
    'public.admit_chat_turn_v2(uuid,uuid,boolean,uuid,text,uuid,text,jsonb,timestamptz,uuid,uuid,text,text,text,jsonb,jsonb,text,integer)'
  ) is null then
    raise exception 'direct chat admission v2 is missing';
  end if;
  if not has_function_privilege(
    'service_role',
    'public.admit_chat_turn_v2(uuid,uuid,boolean,uuid,text,uuid,text,jsonb,timestamptz,uuid,uuid,text,text,text,jsonb,jsonb,text,integer)',
    'EXECUTE'
  ) or has_function_privilege(
    'authenticated',
    'public.admit_chat_turn_v2(uuid,uuid,boolean,uuid,text,uuid,text,jsonb,timestamptz,uuid,uuid,text,text,text,jsonb,jsonb,text,integer)',
    'EXECUTE'
  ) or has_function_privilege(
    'anon',
    'public.admit_chat_turn_v2(uuid,uuid,boolean,uuid,text,uuid,text,jsonb,timestamptz,uuid,uuid,text,text,text,jsonb,jsonb,text,integer)',
    'EXECUTE'
  ) then
    raise exception 'direct chat admission v2 privileges are not closed';
  end if;
  if not public.runtime_healthcheck_v16() then
    raise exception 'runtime v16 rejected the direct chat schema';
  end if;
  if public.verify_schema_contract_v2(
    2,
    'c0c1dd9dcf788761cae5ac5a0bcb3ddd49e13ab8c59638e2c91d53ce1c5fcacc',
    45
  ) then
    raise exception 'obsolete schema contract stayed ready after its authority was removed';
  end if;

  admitted := public.admit_chat_turn_v2(
    'a2900000-0000-4000-8000-000000000001',
    'a2901000-0000-4000-8000-000000000001',
    true, null, 'Direct atomic chat',
    'a2902000-0000-4000-8000-000000000001',
    'hello from direct admission',
    '{"refs":["https://example.test/image.png"],"image_summary":null,"generated_media":[]}'::jsonb,
    clock_timestamp(),
    'a2902000-0000-4000-8000-000000000002',
    'a2903000-0000-4000-8000-000000000001',
    'registered',
    'direct-chat-v2-first',
    repeat('a', 64),
    jsonb_build_object(
      'schemaVersion', 2,
      'payloadHash', repeat('a', 64),
      'outputKind', 'text',
      'billingClass', 'platform',
      'command', jsonb_build_object(
        'schemaVersion', 1,
        'policyVersion', '2026-07-13',
        'tier', '绝句',
        'searchMode', 'off',
        'deepResearch', false,
        'historyRetrieval', false,
        'usingBalance', false,
        'outputKind', 'text',
        'requestedAt', clock_timestamp()
      )
    ),
    '{"wallTimeMs":600000,"tokenLimit":160000,"toolCallLimit":64}'::jsonb,
    'chat', 3
  );
  if admitted->>'enqueued' <> 'true'
     or admitted->>'conversationCreated' <> 'true'
     or admitted->'job'->>'id' <> 'a2903000-0000-4000-8000-000000000001' then
    raise exception 'direct chat admission did not enqueue exactly once: %', admitted;
  end if;
  if (select count(*) from public.messages
      where conversation_id = 'a2901000-0000-4000-8000-000000000001') <> 2
     or (select count(*) from public.jobs
         where id = 'a2903000-0000-4000-8000-000000000001') <> 1
     or not exists (
       select 1 from public.messages
       where id = 'a2902000-0000-4000-8000-000000000002'
         and generation_id = 'a2903000-0000-4000-8000-000000000001'
         and status = 'streaming'
     )
     or not exists (
       select 1 from public.jobs
       where id = 'a2903000-0000-4000-8000-000000000001'
         and payload->'command'->>'tier' = '绝句'
         and payload ? 'payloadHash'
         and not (payload ? 'payloadRef')
     ) then
    raise exception 'direct chat admission left a partial durable graph';
  end if;

  replayed := public.admit_chat_turn_v2(
    'a2900000-0000-4000-8000-000000000001',
    'a2901000-0000-4000-8000-000000000001',
    true, null, 'Direct atomic chat',
    'a2902000-0000-4000-8000-000000000001',
    'hello from direct admission',
    '{"refs":["https://example.test/image.png"],"image_summary":null,"generated_media":[]}'::jsonb,
    clock_timestamp(),
    'a2902000-0000-4000-8000-000000000002',
    'a2903000-0000-4000-8000-000000000001',
    'registered',
    'direct-chat-v2-first',
    repeat('a', 64),
    (select payload from public.jobs
     where id = 'a2903000-0000-4000-8000-000000000001'),
    '{"wallTimeMs":600000,"tokenLimit":160000,"toolCallLimit":64}'::jsonb,
    'chat', 3
  );
  if replayed->>'replayed' <> 'true'
     or (select count(*) from public.messages
         where conversation_id = 'a2901000-0000-4000-8000-000000000001') <> 2
     or (select count(*) from public.jobs
         where id = 'a2903000-0000-4000-8000-000000000001') <> 1 then
    raise exception 'direct chat replay was not idempotent: %', replayed;
  end if;

  begin
    perform public.admit_chat_turn_v2(
      'a2900000-0000-4000-8000-000000000002',
      'a2901000-0000-4000-8000-000000000001',
      false, null, 'Cross tenant',
      'a2902000-0000-4000-8000-000000000011', 'must roll back', null,
      clock_timestamp(),
      'a2902000-0000-4000-8000-000000000012',
      'a2903000-0000-4000-8000-000000000011',
      'registered', 'direct-chat-v2-cross-tenant', repeat('b', 64),
      '{"schemaVersion":2,"payloadHash":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","outputKind":"text","billingClass":"platform","command":{"schemaVersion":1}}'::jsonb,
      '{"wallTimeMs":600000,"tokenLimit":160000}'::jsonb,
      'chat', 3
    );
    raise exception 'cross-tenant direct admission was accepted';
  exception when foreign_key_violation then null;
  end;
  if exists (
    select 1 from public.messages
    where id in (
      'a2902000-0000-4000-8000-000000000011',
      'a2902000-0000-4000-8000-000000000012'
    )
  ) or exists (
    select 1 from public.jobs
    where id = 'a2903000-0000-4000-8000-000000000011'
  ) then
    raise exception 'failed direct admission committed a partial graph';
  end if;
end;
$$;

reset request.jwt.claim.role;
reset role;
