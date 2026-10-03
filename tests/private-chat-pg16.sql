\set ON_ERROR_STOP on
reset role;
insert into auth.users(id) values('a3910000-0000-4000-8000-000000000001') on conflict do nothing;
insert into public.profiles(user_id,balance,limit_5h,limit_week)
values('a3910000-0000-4000-8000-000000000001',10000000,10000000,10000000) on conflict do nothing;
set role service_role;
set request.jwt.claim.role='';
set request.jwt.claims='{"role":"service_role"}';
do $$ declare v jsonb; claim jsonb; begin
  v:=public.admit_private_chat_v1('a3911000-0000-4000-8000-000000000001',
    'a3910000-0000-4000-8000-000000000001','registered','openai/audit','private-worker',160000);
  if v->>'status'<>'leased' or v->>'attempt'<>'1'
    or v->'subject'<>'{}'::jsonb or v->'input' ? 'messages' then
    raise exception 'private admission metadata or lease mismatch: %',v; end if;
  if (select sku from public.job_admission_reservations where job_id='a3911000-0000-4000-8000-000000000001') <> 'chat.text' then
    raise exception 'private work bypassed chat billing'; end if;
  claim:=public.claim_next_job('other-worker',array['chat'],30);
  if claim->'job'->>'id'='a3911000-0000-4000-8000-000000000001' then
    raise exception 'worker raced the private inline lease'; end if;
  begin
    perform public.finalize_job('a3911000-0000-4000-8000-000000000001','private-worker',1,'completed',
      '{"content":"private plaintext"}',null,null,'[]','[]');
    raise exception 'private plaintext result accepted';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.append_job_events('a3911000-0000-4000-8000-000000000001','private-worker',1,
      '[{"kind":"text.delta","payload":{"text":"private"}}]');
    raise exception 'private text event accepted';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.checkpoint_job_with_accounting('a3911000-0000-4000-8000-000000000001','private-worker',1,1,0,
      'private-checkpoint','model-call','{"messages":[{"content":"private"}]}','{}',true,'running','[]');
    raise exception 'private checkpoint accepted';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.record_job_tool_effect('a3911000-0000-4000-8000-000000000001','private-worker',1,
      'tool-private','fetch_url',repeat('a',64),'private-effect','reserved',null,false,'{"arguments":"private"}');
    raise exception 'private tool content accepted';
  exception when invalid_parameter_value then null; end;
  v:=public.finalize_job('a3911000-0000-4000-8000-000000000001','private-worker',1,'completed',
    '{"schemaVersion":1,"totalTokens":17}',null,null,
    '[{"idempotencyKey":"private-usage-test","reason":"platform_model_usage","direction":"debit","weightedTokens":17,"rawTokens":17,"model":"openai/audit","provider":"openrouter","costEstimate":0.000017,"currency":"USD","metadata":{"private":true}}]','[]');
  if v->>'finalized' <> 'true' then raise exception 'private finalize failed: %',v; end if;
end; $$;
-- Reservation settlement is deferred until commit so all final usage is visible.
do $$ begin
  if (select status from public.job_admission_reservations where job_id='a3911000-0000-4000-8000-000000000001')='held' then
    raise exception 'private committed terminal retained hold'; end if;
  if (select actual_tokens from public.job_admission_reservations where job_id='a3911000-0000-4000-8000-000000000001') <> 17
    or (select count(*) from public.ledger_entries where job_id='a3911000-0000-4000-8000-000000000001' and raw_tokens=17) <> 1 then
    raise exception 'private usage did not settle once'; end if;
end; $$;
reset role;
-- Expired private work fails closed through the existing worker and releases its hold.
select public.admit_private_chat_v1('a3911000-0000-4000-8000-000000000002',
'a3910000-0000-4000-8000-000000000001','registered','openai/audit','private-worker',160000);
update public.jobs set lease_expires_at=clock_timestamp()-interval '1 second',priority=1000
where id='a3911000-0000-4000-8000-000000000002';
select public.claim_next_job('recovery-worker',array['chat'],30);
do $$ begin
 if (select status from public.jobs where id='a3911000-0000-4000-8000-000000000002')<>'failed'
 or (select status from public.job_admission_reservations where job_id='a3911000-0000-4000-8000-000000000002')='held' then
 raise exception 'private crash was replayed or its hold was not settled'; end if;
end; $$;
-- Production PostgREST supplies JSON claims rather than the legacy per-claim GUC.
update public.conversations set memory_enabled=true where id='a3901000-0000-4000-8000-000000000001';
set request.jwt.claims='{"role":"authenticated"}';
do $$ begin
 begin
 update public.conversations set memory_enabled=false where id='a3901000-0000-4000-8000-000000000001';
 raise exception 'authenticated JSON claims bypassed memory lock';
 exception when sqlstate '55000' then null; end;
end; $$;
reset request.jwt.claims;
