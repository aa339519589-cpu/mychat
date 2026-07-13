\set ON_ERROR_STOP on

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id),
  balance numeric not null default 0
);
insert into public.profiles(user_id, balance) values
  ('00000000-0000-4000-8000-000000000001', 9)
on conflict (user_id) do update set balance = excluded.balance;

insert into public.messages(id, conversation_id, user_id, role, content) values
  ('84200000-0000-4000-8000-000000000001', '80000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', 'user', 'make canonical media'),
  ('84200000-0000-4000-8000-000000000002', '80000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', 'assistant', ''),
  ('84200000-0000-4000-8000-000000000003', '80000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', 'user', 'make orphan media'),
  ('84200000-0000-4000-8000-000000000004', '80000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', 'assistant', '');

set role service_role;
do $$
declare
  result jsonb;
  asset_key text := '00000000-0000-4000-8000-000000000001/80000000-0000-4000-8000-000000000002/84000000-0000-4000-8000-000000000001/asset.png';
  orphan_key text := '00000000-0000-4000-8000-000000000001/80000000-0000-4000-8000-000000000002/84000000-0000-4000-8000-000000000002/orphan.png';
begin
  result := public.enqueue_job(
    '84000000-0000-4000-8000-000000000001', 'chat.generation', 'asset_test',
    '00000000-0000-4000-8000-000000000001', 'registered',
    jsonb_build_object(
      'conversationId', '80000000-0000-4000-8000-000000000002',
      'userMessageId', '84200000-0000-4000-8000-000000000001',
      'assistantMessageId', '84200000-0000-4000-8000-000000000002'
    ),
    'asset-canonical-intent', repeat('d', 64), '{"outputKind":"image"}'::jsonb
  );
  result := public.claim_next_job('asset-worker-1', array['asset_test'], 120);
  result := public.record_job_asset(
    '84000000-0000-4000-8000-000000000001', 'asset-worker-1', 1,
    '00000000-0000-4000-8000-000000000001', 'generated-media', asset_key,
    'image', 'image/png', 128, 'reserved'
  );
  if result->>'recorded' <> 'true' then raise exception 'asset reserve failed: %', result; end if;
  result := public.record_job_asset(
    '84000000-0000-4000-8000-000000000001', 'asset-worker-1', 1,
    '00000000-0000-4000-8000-000000000001', 'generated-media', asset_key,
    'image', 'image/png', 128, 'uploaded'
  );
  result := public.finalize_job(
    '84000000-0000-4000-8000-000000000001', 'asset-worker-1', 1,
    'completed', jsonb_build_object('assetObjectKeys', jsonb_build_array(asset_key))
  );
  if result->>'status' <> 'completed' then raise exception 'asset finalize failed: %', result; end if;

  result := public.enqueue_job(
    '84000000-0000-4000-8000-000000000002', 'chat.generation', 'asset_test',
    '00000000-0000-4000-8000-000000000001', 'registered',
    jsonb_build_object(
      'conversationId', '80000000-0000-4000-8000-000000000002',
      'userMessageId', '84200000-0000-4000-8000-000000000003',
      'assistantMessageId', '84200000-0000-4000-8000-000000000004'
    ),
    'asset-orphan-intent', repeat('e', 64), '{"outputKind":"image"}'::jsonb
  );
  result := public.claim_next_job('asset-worker-2', array['asset_test'], 120);
  result := public.record_job_asset(
    '84000000-0000-4000-8000-000000000002', 'asset-worker-2', 1,
    '00000000-0000-4000-8000-000000000001', 'generated-media', orphan_key,
    'image', 'image/png', 64, 'uploaded'
  );
  result := public.finalize_job(
    '84000000-0000-4000-8000-000000000002', 'asset-worker-2', 1,
    'failed', '{}'::jsonb, 'internal', 'asset_test_failure'
  );
end;
$$;
reset role;

do $$
begin
  if (select state from public.job_assets where job_id = '84000000-0000-4000-8000-000000000001') <> 'canonical' then
    raise exception 'terminal CAS did not canonicalize the listed asset';
  end if;
  if (select state from public.job_assets where job_id = '84000000-0000-4000-8000-000000000002') <> 'uploaded' then
    raise exception 'failed job orphan was incorrectly canonicalized';
  end if;
  if not exists (
    select 1 from public.job_outbox
    where job_id = '84000000-0000-4000-8000-000000000002' and topic = 'assets.cleanup'
  ) then raise exception 'orphan cleanup was not enqueued'; end if;
end;
$$;

set role authenticated;
set request.jwt.claim.sub = '00000000-0000-4000-8000-000000000001';
do $$
declare quota jsonb;
begin
  quota := public.get_ledger_quota_status('00000000-0000-4000-8000-000000000001');
  if (quota->>'tokens5h')::bigint < 7 or (quota->>'tokens7d')::bigint < 7 then
    raise exception 'ledger quota omitted finalized usage: %', quota;
  end if;
  if quota->>'balance' <> '9' then raise exception 'ledger quota balance mismatch: %', quota; end if;
  begin
    perform public.get_ledger_quota_status('00000000-0000-4000-8000-000000000002');
    raise exception 'cross-tenant quota read succeeded';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset role;
