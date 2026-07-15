\set ON_ERROR_STOP on

do $$
begin
  if has_function_privilege(
    'authenticated',
    'public.enqueue_agent_task_job(uuid,uuid,text,text,uuid,uuid,uuid,uuid,text,text,text,jsonb)',
    'EXECUTE'
  ) or has_function_privilege(
    'authenticated',
    'public.enqueue_agent_operation(uuid,uuid,uuid,text,text,text,uuid,text,text,text,jsonb,text,text)',
    'EXECUTE'
  ) or has_function_privilege(
    'authenticated', 'public.merge_agent_task_meta(uuid,jsonb,text[])', 'EXECUTE'
  ) or has_function_privilege(
    'authenticated', 'public.merge_agent_run_state(uuid,jsonb)', 'EXECUTE'
  ) or coalesce(has_function_privilege(
    'authenticated', to_regprocedure('public.claim_agent_run(uuid,text,integer)'), 'EXECUTE'
  ), false) then
    raise exception 'authenticated retained an Agent admission or lifecycle mutation RPC';
  end if;
  if not has_function_privilege(
    'service_role',
    'public.enqueue_agent_task_job(uuid,uuid,text,text,uuid,uuid,uuid,uuid,text,text,text,jsonb)',
    'EXECUTE'
  ) or not has_function_privilege(
    'service_role',
    'public.enqueue_agent_operation(uuid,uuid,uuid,text,text,text,uuid,text,text,text,jsonb,text,text)',
    'EXECUTE'
  ) then
    raise exception 'command service lost Agent admission authority';
  end if;
  if has_table_privilege('authenticated', 'public.job_admission_reservations', 'SELECT')
     or has_table_privilege('authenticated', 'public.job_price_catalog', 'SELECT') then
    raise exception 'billing authority leaked to browser role';
  end if;
end;
$$;

insert into public.profiles(user_id, balance, limit_5h, limit_week)
values ('00000000-0000-4000-8000-000000000002', 30000, 0, 0)
on conflict (user_id) do update set
  balance = excluded.balance,
  limit_5h = excluded.limit_5h,
  limit_week = excluded.limit_week;

insert into public.conversations(id, user_id) values
  ('89900000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'),
  ('89900000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000002')
on conflict (id) do nothing;

create or replace function public.pg16_admission_attempt(
  input_job_id uuid,
  input_conversation_id uuid,
  input_idempotency_key text
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.enqueue_job(
    input_job_id, 'chat.title', 'admission_race',
    '00000000-0000-4000-8000-000000000002', 'registered',
    jsonb_build_object('conversationId', input_conversation_id),
    input_idempotency_key, repeat('9', 64),
    '{"schemaVersion":1,"billingClass":"platform"}'::jsonb,
    '{"wallTimeMs":60000,"tokenLimit":8192}'::jsonb
  );
  return 'admitted';
exception when raise_exception then
  if sqlerrm = 'insufficient_job_credit' then return 'rejected'; end if;
  raise;
end;
$$;
revoke all on function public.pg16_admission_attempt(uuid,uuid,text)
  from public, anon, authenticated, service_role;
grant execute on function public.pg16_admission_attempt(uuid,uuid,text) to service_role;

-- Exact remaining quota is admissible; one token less must require a balance
-- hold. This catches the classic committed+held check that omits the new quote.
update public.profiles set balance = 0, limit_5h = 24576, limit_week = 24576
where user_id = '00000000-0000-4000-8000-000000000002';
do $$
declare v_result text;
begin
  v_result := public.pg16_admission_attempt(
    '89910000-0000-4000-8000-000000000010',
    '89900000-0000-4000-8000-000000000001',
    'admission-exact-limit'
  );
  if v_result <> 'admitted' or not exists (
    select 1 from public.job_admission_reservations
    where job_id = '89910000-0000-4000-8000-000000000010' and funding = 'quota'
  ) then raise exception 'exact quota boundary was not admitted'; end if;
  perform public.cancel_job(
    '89910000-0000-4000-8000-000000000010',
    '00000000-0000-4000-8000-000000000002',
    'boundary fixture cleanup'
  );
end;
$$;

update public.profiles set balance = 0, limit_5h = 24575, limit_week = 24575
where user_id = '00000000-0000-4000-8000-000000000002';
do $$
declare v_result text;
begin
  v_result := public.pg16_admission_attempt(
    '89910000-0000-4000-8000-000000000011',
    '89900000-0000-4000-8000-000000000002',
    'admission-over-limit'
  );
  if v_result <> 'rejected' or exists (
    select 1 from public.jobs where id = '89910000-0000-4000-8000-000000000011'
  ) then raise exception 'over-limit admission was not atomically rejected'; end if;
end;
$$;

update public.profiles set balance = 30000, limit_5h = 0, limit_week = 0
where user_id = '00000000-0000-4000-8000-000000000002';
