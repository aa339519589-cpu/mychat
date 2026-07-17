\set ON_ERROR_STOP on

insert into auth.users(id) values
  ('a1700000-0000-4000-8000-000000000001'),
  ('a1700000-0000-4000-8000-000000000002')
on conflict (id) do nothing;
insert into public.profiles(user_id, balance, limit_5h, limit_week) values
  ('a1700000-0000-4000-8000-000000000001', 10000000, 10000000, 10000000),
  ('a1700000-0000-4000-8000-000000000002', 10000000, 10000000, 10000000)
on conflict (user_id) do update set
  balance = excluded.balance,
  limit_5h = excluded.limit_5h,
  limit_week = excluded.limit_week;
insert into public.code_sessions(id, user_id, repo) values (
  'a1705000-0000-4000-8000-000000000001',
  'a1700000-0000-4000-8000-000000000001', 'owner/repo'
);
insert into public.code_messages(id, session_id, user_id, role, content) values (
  'a1706000-0000-4000-8000-000000000001',
  'a1705000-0000-4000-8000-000000000001',
  'a1700000-0000-4000-8000-000000000001', 'user', 'implement'
);

set role service_role;
set request.jwt.claim.role = 'service_role';

do $$
declare
  heartbeat jsonb;
  readiness jsonb;
  chat_result jsonb;
  replay_result jsonb;
  agent_result jsonb;
  stream_result jsonb;
  agent_cap bigint;
  agent_price_version integer;
  queue_sample jsonb;
begin
  if has_function_privilege(
    'authenticated',
    'public.enqueue_chat_turn_v1(uuid,uuid,boolean,uuid,text,uuid,text,jsonb,timestamptz,uuid,uuid,text,text,text,jsonb,jsonb,text,integer)',
    'EXECUTE'
  ) or has_function_privilege(
    'authenticated',
    'public.enqueue_chat_regeneration_v1(uuid,uuid,text,uuid,uuid,uuid,text,uuid,uuid,text,text,text,jsonb,jsonb,text,integer,text[])',
    'EXECUTE'
  ) or has_function_privilege(
    'authenticated', 'public.heartbeat_job_worker_v2(text,text,jsonb,timestamptz,boolean)', 'EXECUTE'
  ) or has_table_privilege(
    'service_role', 'public.job_stream_capacity_counters',
    'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
  ) then
    raise exception 'platform v2 authority leaked to a runtime role';
  end if;

  heartbeat := public.heartbeat_job_worker_v2(
    'platform-v2-worker', 'abcdef012345',
    '{"chat":2,"media":1,"title":1,"agent":1,"outbox":1}'::jsonb,
    clock_timestamp(), false
  );
  if heartbeat->>'accepted' <> 'true' or heartbeat->>'capacity' <> '6' then
    raise exception 'process heartbeat was rejected: %', heartbeat;
  end if;
  readiness := public.read_job_worker_readiness_v3(
    array['chat','media','title','agent','outbox'], 20, 'abcdef012345'
  );
  if readiness->>'ready' <> 'true'
     or readiness->>'activeWorkers' <> '1'
     or readiness->>'totalCapacity' <> '6' then
    raise exception 'process-scoped readiness is inconsistent: %', readiness;
  end if;
  select value into queue_sample
  from jsonb_array_elements(readiness->'queues') as value
  where value->>'queue' = 'chat';
  if queue_sample->>'activeWorkers' <> '1'
     or queue_sample->>'totalCapacity' <> '2' then
    raise exception 'chat queue capacity was overstated: %', queue_sample;
  end if;

  chat_result := public.enqueue_chat_turn_v1(
    'a1700000-0000-4000-8000-000000000001',
    'a1701000-0000-4000-8000-000000000001', true, null, 'Atomic chat',
    'a1702000-0000-4000-8000-000000000001', 'hello authority', null,
    clock_timestamp(),
    'a1702000-0000-4000-8000-000000000002',
    'a1703000-0000-4000-8000-000000000001', 'registered',
    'platform-v2-chat-turn', repeat('a', 64),
    '{"schemaVersion":1,"outputKind":"text","billingClass":"customer"}'::jsonb,
    '{"wallTimeMs":600000,"tokenLimit":160000,"toolCallLimit":64}'::jsonb,
    'chat', 3
  );
  if chat_result->>'enqueued' <> 'true'
     or chat_result->>'conversationCreated' <> 'true' then
    raise exception 'atomic chat turn was not created: %', chat_result;
  end if;
  if (select count(*) from public.messages
      where conversation_id = 'a1701000-0000-4000-8000-000000000001') <> 2
     or not exists (
       select 1 from public.chat_generations
       where id = 'a1703000-0000-4000-8000-000000000001'
         and assistant_message_id = 'a1702000-0000-4000-8000-000000000002'
     )
     or exists (
       select 1 from public.job_outbox
       where job_id = 'a1703000-0000-4000-8000-000000000001'
         and topic in ('jobs.ready','jobs.terminal','jobs.cancel_requested','jobs.poison')
     ) then
    raise exception
      'atomic chat turn left a partial or ceremonial projection: messages=%, generation=%, ceremonial=%',
      (select count(*) from public.messages
       where conversation_id = 'a1701000-0000-4000-8000-000000000001'),
      exists (
        select 1 from public.chat_generations
        where id = 'a1703000-0000-4000-8000-000000000001'
          and assistant_message_id = 'a1702000-0000-4000-8000-000000000002'
      ),
      exists (
        select 1 from public.job_outbox
        where job_id = 'a1703000-0000-4000-8000-000000000001'
          and topic in ('jobs.ready','jobs.terminal','jobs.cancel_requested','jobs.poison')
      );
  end if;

  replay_result := public.enqueue_chat_turn_v1(
    'a1700000-0000-4000-8000-000000000001',
    'a1701000-0000-4000-8000-000000000001', true, null, 'Atomic chat',
    'a1702000-0000-4000-8000-000000000001', 'hello authority', null,
    clock_timestamp(),
    'a1702000-0000-4000-8000-000000000002',
    'a1703000-0000-4000-8000-000000000001', 'registered',
    'platform-v2-chat-turn', repeat('a', 64),
    '{"schemaVersion":1,"outputKind":"text","billingClass":"customer"}'::jsonb,
    '{"wallTimeMs":600000,"tokenLimit":160000,"toolCallLimit":64}'::jsonb,
    'chat', 3
  );
  if replay_result->>'replayed' <> 'true'
     or (select count(*) from public.messages
         where conversation_id = 'a1701000-0000-4000-8000-000000000001') <> 2 then
    raise exception 'chat turn replay was not idempotent: %', replay_result;
  end if;

  begin
    perform public.enqueue_chat_turn_v1(
      'a1700000-0000-4000-8000-000000000002',
      'a1701000-0000-4000-8000-000000000001', false, null, 'Forbidden',
      'a1702000-0000-4000-8000-000000000011', 'cross tenant', null,
      clock_timestamp(),
      'a1702000-0000-4000-8000-000000000012',
      'a1703000-0000-4000-8000-000000000011', 'registered',
      'platform-v2-cross-tenant', repeat('b', 64),
      '{"schemaVersion":1,"outputKind":"text","billingClass":"customer"}'::jsonb,
      '{"wallTimeMs":600000,"tokenLimit":160000}'::jsonb, 'chat', 3
    );
    raise exception 'cross-tenant chat turn was accepted';
  exception when foreign_key_violation then null;
  end;

  stream_result := public.acquire_job_event_stream(
    'a1704000-0000-4000-8000-000000000001',
    'a1700000-0000-4000-8000-000000000001',
    'a1703000-0000-4000-8000-000000000001', repeat('1', 64), 45, 900
  );
  if stream_result->>'acquired' <> 'true' then raise exception 'first stream failed: %', stream_result; end if;
  stream_result := public.acquire_job_event_stream(
    'a1704000-0000-4000-8000-000000000002',
    'a1700000-0000-4000-8000-000000000001',
    'a1703000-0000-4000-8000-000000000001', repeat('2', 64), 45, 900
  );
  if stream_result->>'acquired' <> 'true' then raise exception 'second stream failed: %', stream_result; end if;
  stream_result := public.acquire_job_event_stream(
    'a1704000-0000-4000-8000-000000000003',
    'a1700000-0000-4000-8000-000000000001',
    'a1703000-0000-4000-8000-000000000001', repeat('3', 64), 45, 900
  );
  if stream_result->>'acquired' <> 'false' or stream_result->>'reason' <> 'capacity' then
    raise exception 'per-Job stream limit was not exact: %', stream_result;
  end if;
  perform public.release_job_event_stream('a1704000-0000-4000-8000-000000000001');
  perform public.release_job_event_stream('a1704000-0000-4000-8000-000000000002');
  stream_result := public.acquire_job_event_stream(
    'a1704000-0000-4000-8000-000000000003',
    'a1700000-0000-4000-8000-000000000001',
    'a1703000-0000-4000-8000-000000000001', repeat('3', 64), 45, 900
  );
  if stream_result->>'acquired' <> 'true' then
    raise exception 'stream release did not restore exact capacity: %', stream_result;
  end if;
  perform public.release_job_event_stream('a1704000-0000-4000-8000-000000000003');

  perform public.cancel_job(
    'a1703000-0000-4000-8000-000000000001',
    'a1700000-0000-4000-8000-000000000001', 'regeneration setup'
  );
end;
$$;

-- Seed the canonical asset as the migration owner. service_role is intentionally
-- read-only on job_assets; runtime writes must go through fenced asset RPCs.
reset request.jwt.claim.role;
reset role;
  insert into public.job_assets(
    job_id, principal_id, bucket, object_key, media_type, mime_type,
    bytes, state, lease_version, canonical_at
  ) values (
    'a1703000-0000-4000-8000-000000000001',
    'a1700000-0000-4000-8000-000000000001', 'generated-media',
    'a1700000-0000-4000-8000-000000000001/a1701000-0000-4000-8000-000000000001/a1703000-0000-4000-8000-000000000001/asset.png',
    'image', 'image/png', 1024, 'canonical', 1, clock_timestamp()
  );

set role service_role;
set request.jwt.claim.role = 'service_role';

do $$
declare
  chat_result jsonb;
  replay_result jsonb;
  agent_result jsonb;
  agent_cap bigint;
  agent_price_version integer;
begin
  chat_result := public.enqueue_chat_regeneration_v1(
    'a1700000-0000-4000-8000-000000000001',
    'a1701000-0000-4000-8000-000000000001', 'replace-assistant',
    'a1702000-0000-4000-8000-000000000001',
    'a1702000-0000-4000-8000-000000000002',
    'a1702000-0000-4000-8000-000000000002', 'hello authority',
    'a1702000-0000-4000-8000-000000000003',
    'a1703000-0000-4000-8000-000000000002', 'registered',
    'platform-v2-regenerate-assistant', repeat('d', 64),
    '{"schemaVersion":1,"outputKind":"text","billingClass":"customer"}'::jsonb,
    '{"wallTimeMs":600000,"tokenLimit":160000,"toolCallLimit":64}'::jsonb,
    'chat', 3, array[]::text[]
  );
  if chat_result->>'enqueued' <> 'true'
     or exists (select 1 from public.messages where id = 'a1702000-0000-4000-8000-000000000002')
     or not exists (
       select 1 from public.chat_generations
       where id = 'a1703000-0000-4000-8000-000000000002'
         and assistant_message_id = 'a1702000-0000-4000-8000-000000000003'
     )
     or (select state from public.job_assets
         where job_id = 'a1703000-0000-4000-8000-000000000001') <> 'deleting'
     or not exists (
       select 1 from public.generated_media_cleanup_jobs
       where generation_id = 'a1703000-0000-4000-8000-000000000001'
         and reason = 'history_delete' and completed_at is null
     )
     or not exists (
       select 1 from public.job_outbox
       where job_id = 'a1703000-0000-4000-8000-000000000001'
         and topic = 'assets.cleanup'
     ) then
    raise exception 'assistant regeneration was not atomic: %', chat_result;
  end if;

  replay_result := public.enqueue_chat_regeneration_v1(
    'a1700000-0000-4000-8000-000000000001',
    'a1701000-0000-4000-8000-000000000001', 'replace-assistant',
    'a1702000-0000-4000-8000-000000000001',
    'a1702000-0000-4000-8000-000000000002',
    'a1702000-0000-4000-8000-000000000002', 'hello authority',
    'a1702000-0000-4000-8000-000000000003',
    'a1703000-0000-4000-8000-000000000002', 'registered',
    'platform-v2-regenerate-assistant', repeat('d', 64),
    '{"schemaVersion":1,"outputKind":"text","billingClass":"customer"}'::jsonb,
    '{"wallTimeMs":600000,"tokenLimit":160000,"toolCallLimit":64}'::jsonb,
    'chat', 3, array[]::text[]
  );
  if replay_result->>'replayed' <> 'true'
     or (select count(*) from public.messages
         where conversation_id = 'a1701000-0000-4000-8000-000000000001') <> 2 then
    raise exception 'regeneration replay mutated the branch: %', replay_result;
  end if;

  begin
    perform public.enqueue_chat_regeneration_v1(
      'a1700000-0000-4000-8000-000000000001',
      'a1701000-0000-4000-8000-000000000001', 'replace-from-user',
      'a1702000-0000-4000-8000-000000000001', null,
      'a1702000-0000-4000-8000-000000000003', 'must not run',
      'a1702000-0000-4000-8000-000000000008',
      'a1703000-0000-4000-8000-000000000008', 'registered',
      'platform-v2-regeneration-active', repeat('e', 64),
      '{"schemaVersion":1,"outputKind":"text","billingClass":"customer"}'::jsonb,
      '{"wallTimeMs":600000,"tokenLimit":160000}'::jsonb,
      'chat', 3, array[]::text[]
    );
    raise exception 'active regeneration was accepted';
  exception when sqlstate '55000' then null;
  end;
  perform public.cancel_job(
    'a1703000-0000-4000-8000-000000000002',
    'a1700000-0000-4000-8000-000000000001', 'regeneration rollover'
  );

  begin
    perform public.enqueue_chat_regeneration_v1(
      'a1700000-0000-4000-8000-000000000001',
      'a1701000-0000-4000-8000-000000000001', 'replace-from-user',
      'a1702000-0000-4000-8000-000000000001', null,
      'a1702000-0000-4000-8000-000000000003', 'rollback probe',
      'a1702000-0000-4000-8000-000000000009',
      'a1703000-0000-4000-8000-000000000001', 'registered',
      'platform-v2-regeneration-rollback', repeat('f', 64),
      '{"schemaVersion":1,"outputKind":"text","billingClass":"customer"}'::jsonb,
      '{"wallTimeMs":600000,"tokenLimit":160000}'::jsonb,
      'chat', 3, array[]::text[]
    );
    raise exception 'conflicting regeneration unexpectedly committed';
  exception when unique_violation then null;
  end;
  if (select content from public.messages
      where id = 'a1702000-0000-4000-8000-000000000001') <> 'hello authority'
     or not exists (
       select 1 from public.messages where id = 'a1702000-0000-4000-8000-000000000003'
     ) then
    raise exception 'failed regeneration left a partial branch mutation';
  end if;

  begin
    perform public.enqueue_chat_regeneration_v1(
      'a1700000-0000-4000-8000-000000000001',
      'a1701000-0000-4000-8000-000000000001', 'replace-from-user',
      'a1702000-0000-4000-8000-000000000001', null,
      'a1702000-0000-4000-8000-000000000002', 'stale branch',
      'a1702000-0000-4000-8000-000000000009',
      'a1703000-0000-4000-8000-000000000009', 'registered',
      'platform-v2-regeneration-stale', repeat('1', 64),
      '{"schemaVersion":1,"outputKind":"text","billingClass":"customer"}'::jsonb,
      '{"wallTimeMs":600000,"tokenLimit":160000}'::jsonb,
      'chat', 3, array[]::text[]
    );
    raise exception 'stale regeneration tail was accepted';
  exception when serialization_failure then null;
  end;

  chat_result := public.enqueue_chat_regeneration_v1(
    'a1700000-0000-4000-8000-000000000001',
    'a1701000-0000-4000-8000-000000000001', 'replace-from-user',
    'a1702000-0000-4000-8000-000000000001', null,
    'a1702000-0000-4000-8000-000000000003', 'edited authority',
    'a1702000-0000-4000-8000-000000000004',
    'a1703000-0000-4000-8000-000000000003', 'registered',
    'platform-v2-regenerate-from-user', repeat('2', 64),
    '{"schemaVersion":1,"outputKind":"text","billingClass":"customer"}'::jsonb,
    '{"wallTimeMs":600000,"tokenLimit":160000,"toolCallLimit":64}'::jsonb,
    'chat', 3, array[]::text[]
  );
  if chat_result->>'enqueued' <> 'true'
     or (select content from public.messages
         where id = 'a1702000-0000-4000-8000-000000000001') <> 'edited authority'
     or exists (select 1 from public.messages where id = 'a1702000-0000-4000-8000-000000000003')
     or not exists (
       select 1 from public.chat_generations
       where id = 'a1703000-0000-4000-8000-000000000003'
         and assistant_message_id = 'a1702000-0000-4000-8000-000000000004'
     ) then
    raise exception 'edited regeneration did not replace the branch: %', chat_result;
  end if;

  select catalog.raw_token_cap, catalog.version
  into strict agent_cap, agent_price_version
  from public.job_price_activation_heads as head
  join public.job_price_activations as activation
    on activation.sku = head.sku
   and activation.price_version = head.price_version
   and activation.activation_generation = head.activation_generation
  join public.job_price_catalog as catalog
    on catalog.sku = head.sku and catalog.version = head.price_version
  where head.sku = 'agent.task';

  agent_result := public.enqueue_agent_task_job(
    'a1700000-0000-4000-8000-000000000001',
    'a1707000-0000-4000-8000-000000000001', 'catalog-bound task', 'owner/repo',
    'a1705000-0000-4000-8000-000000000001',
    'a1706000-0000-4000-8000-000000000002',
    'a1706000-0000-4000-8000-000000000001',
    'a1708000-0000-4000-8000-000000000001', 'registered',
    'platform-v2-agent-policy', repeat('c', 64),
    '{"schemaVersion":1,"billingClass":"customer"}'::jsonb
  );
  if agent_result->>'enqueued' <> 'true'
     or (select (budget->>'tokenLimit')::bigint from public.jobs
         where id = 'a1708000-0000-4000-8000-000000000001') <> agent_cap
     or (select (payload->'executionLimits'->>'requestedTokenLimit')::bigint from public.jobs
         where id = 'a1708000-0000-4000-8000-000000000001') <> agent_cap
     or (select (payload->'executionLimits'->>'effectiveTokenLimit')::bigint from public.jobs
         where id = 'a1708000-0000-4000-8000-000000000001') <> agent_cap
     or (select (payload->'executionLimits'->>'priceVersion')::integer from public.jobs
         where id = 'a1708000-0000-4000-8000-000000000001') <> agent_price_version then
    raise exception 'Agent execution policy diverged from catalog: %', agent_result;
  end if;

  perform public.cancel_job(
    'a1703000-0000-4000-8000-000000000003',
    'a1700000-0000-4000-8000-000000000001', 'fixture cleanup'
  );
  perform public.cancel_job(
    'a1708000-0000-4000-8000-000000000001',
    'a1700000-0000-4000-8000-000000000001', 'fixture cleanup'
  );
  if exists (
    select 1 from public.job_outbox
    where job_id in (
      'a1703000-0000-4000-8000-000000000001',
      'a1703000-0000-4000-8000-000000000002',
      'a1703000-0000-4000-8000-000000000003',
      'a1708000-0000-4000-8000-000000000001'
    ) and topic in ('jobs.ready','jobs.terminal','jobs.cancel_requested','jobs.poison')
  ) then
    raise exception 'ceremonial lifecycle outbox rows survived v2';
  end if;

  if not public.runtime_healthcheck_v15() then
    raise exception 'platform authority v2 readiness failed';
  end if;
end;
$$;

reset request.jwt.claim.role;
reset role;
