-- Close the remaining split-brain paths: Agent task creation and job enqueue
-- are one transaction, ledger settlement debits paid balance exactly once,
-- and browser roles can no longer mutate worker-owned lifecycle tables.
begin;

create table if not exists public.ledger_balance_settlements (
  ledger_entry_id uuid primary key references public.ledger_entries(id) on delete restrict,
  principal_id uuid not null,
  requested_tokens bigint not null check (requested_tokens >= 0),
  debited_tokens bigint not null check (debited_tokens >= 0),
  remaining_balance bigint not null check (remaining_balance >= 0),
  created_at timestamptz not null default now()
);
create index if not exists ledger_balance_settlements_principal_created_idx
  on public.ledger_balance_settlements(principal_id, created_at desc);
alter table public.ledger_balance_settlements enable row level security;
drop policy if exists ledger_balance_settlements_select_own on public.ledger_balance_settlements;
create policy ledger_balance_settlements_select_own on public.ledger_balance_settlements
  for select to authenticated using (principal_id = auth.uid());
revoke all on public.ledger_balance_settlements from public, anon, authenticated;
grant select on public.ledger_balance_settlements to authenticated, service_role;
grant insert, update, delete on public.ledger_balance_settlements to service_role;

create or replace function public.settle_ledger_balance_debit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_balance bigint := 0;
  v_debit bigint := 0;
begin
  if new.direction <> 'debit'
     or coalesce(new.metadata->>'usingBalance', 'false') <> 'true'
     or new.weighted_tokens <= 0 then return new; end if;
  insert into public.profiles(user_id, balance)
  values (new.principal_id, 0) on conflict (user_id) do nothing;
  select greatest(coalesce(balance, 0), 0)::bigint into v_balance
  from public.profiles where user_id = new.principal_id for update;
  v_debit := least(v_balance, new.weighted_tokens);
  update public.profiles set
    balance = v_balance - v_debit,
    quota_version = coalesce(quota_version, 0) + 1
  where user_id = new.principal_id;
  insert into public.ledger_balance_settlements(
    ledger_entry_id,principal_id,requested_tokens,debited_tokens,remaining_balance,created_at
  ) values (
    new.id,new.principal_id,new.weighted_tokens,v_debit,v_balance-v_debit,clock_timestamp()
  );
  return new;
end;
$$;

drop trigger if exists settle_ledger_balance_debit on public.ledger_entries;
create trigger settle_ledger_balance_debit
after insert on public.ledger_entries
for each row execute function public.settle_ledger_balance_debit();
revoke all on function public.settle_ledger_balance_debit()
  from public, anon, authenticated;

create or replace function public.enqueue_agent_task_job(
  input_user_id uuid,
  input_task_id uuid,
  input_goal text,
  input_repo text,
  input_session_id uuid,
  input_response_id uuid,
  input_user_message_id uuid,
  input_job_id uuid,
  input_auth_class text,
  input_idempotency_key text,
  input_input_hash text,
  input_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_task public.agent_tasks%rowtype;
  v_result jsonb;
  v_now timestamptz := clock_timestamp();
begin
  perform public.assert_agent_confirmation_actor(input_user_id);
  if input_task_id is null or input_session_id is null or input_response_id is null
     or input_user_message_id is null or input_job_id is null
     or length(coalesce(input_goal, '')) not between 1 and 10000
     or coalesce(input_repo, '') !~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'
     or input_auth_class not in ('anonymous', 'registered')
     or length(coalesce(input_idempotency_key, '')) not between 1 and 256
     or length(coalesce(input_input_hash, '')) not between 16 and 256
     or jsonb_typeof(input_payload) <> 'object' then
    raise exception 'invalid_agent_task_enqueue' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.code_sessions
    where id = input_session_id and user_id = input_user_id and repo = input_repo
  ) or not exists (
    select 1 from public.code_messages
    where id = input_user_message_id and session_id = input_session_id
      and user_id = input_user_id and role = 'user'
  ) then
    raise exception 'agent_task_context_conflict' using errcode = '23503';
  end if;
  insert into public.agent_tasks(
    id,user_id,goal,mode,repo,branch,status,meta,created_at,updated_at
  ) values (
    input_task_id,input_user_id,input_goal,'auto',input_repo,'main','queued',
    jsonb_build_object('authority', 'job-control-plane'),v_now,v_now
  ) on conflict (id) do nothing;
  select * into v_task from public.agent_tasks
  where id = input_task_id and user_id = input_user_id for update;
  if not found or v_task.repo is distinct from input_repo
     or v_task.status in ('completed', 'cancelled') then
    raise exception 'agent_task_state_conflict' using errcode = '23505';
  end if;
  v_result := public.enqueue_job(
    input_job_id => input_job_id,
    input_type => 'agent.task',
    input_queue => 'agent',
    input_principal_id => input_user_id,
    input_auth_class => input_auth_class,
    input_subject => jsonb_build_object(
      'taskId', input_task_id, 'repo', input_repo,
      'sessionId', input_session_id, 'responseId', input_response_id,
      'userMessageId', input_user_message_id
    ),
    input_idempotency_key => input_idempotency_key,
    input_input_hash => input_input_hash,
    input_payload => input_payload,
    input_budget => jsonb_build_object(
      'wallTimeMs', 2700000, 'tokenLimit', 500000,
      'sandboxTimeMs', 2400000, 'toolCallLimit', 256
    ),
    input_priority => 0,
    input_max_attempts => 3,
    input_available_at => v_now
  );
  update public.agent_tasks set status = 'queued', error = null, updated_at = v_now
  where id = input_task_id and user_id = input_user_id;
  return v_result || jsonb_build_object('taskId', input_task_id);
end;
$$;

revoke all on function public.enqueue_agent_task_job(
  uuid,uuid,text,text,uuid,uuid,uuid,uuid,text,text,text,jsonb
) from public, anon;
grant execute on function public.enqueue_agent_task_job(
  uuid,uuid,text,text,uuid,uuid,uuid,uuid,text,text,text,jsonb
) to authenticated, service_role;

create or replace function public.cancel_idle_agent_task(input_task_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_task public.agent_tasks%rowtype;
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  select * into v_task from public.agent_tasks
  where id = input_task_id and user_id = auth.uid() for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if exists (
    select 1 from public.jobs where principal_id = auth.uid()
      and type in ('agent.task','agent.operation')
      and subject->>'taskId' = input_task_id::text
      and status in ('queued','leased','running','awaiting_input','cancelling')
  ) then return jsonb_build_object('ok', false, 'reason', 'active_job'); end if;
  if v_task.status in ('completed','failed','cancelled') then
    return jsonb_build_object('ok', true, 'status', v_task.status, 'replayed', true);
  end if;
  update public.agent_tasks set
    status = 'cancelled', error = null, finished_at = clock_timestamp(), updated_at = clock_timestamp()
  where id = input_task_id and user_id = auth.uid();
  return jsonb_build_object('ok', true, 'status', 'cancelled', 'replayed', false);
end;
$$;
revoke all on function public.cancel_idle_agent_task(uuid) from public, anon;
grant execute on function public.cancel_idle_agent_task(uuid) to authenticated;

-- Lifecycle state and durable artifacts are worker/RPC-owned. Browser roles
-- retain read access through their existing RLS policies.
revoke insert, update, delete on public.agent_tasks from authenticated;
revoke insert, update, delete on public.agent_workspaces from authenticated;
revoke insert, update, delete on public.agent_artifacts from authenticated;
drop policy if exists agent_snapshot_blobs_insert_own on storage.objects;

commit;
