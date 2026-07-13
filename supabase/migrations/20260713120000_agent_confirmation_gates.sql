-- Database-authoritative, single-use approval gates for high-risk Agent work.
-- The browser receives a 256-bit bearer token once. Only its SHA-256 digest is
-- persisted, and every approval is bound to the exact canonical operation plan.
begin;

create extension if not exists pgcrypto;

create table if not exists public.agent_confirmation_gates (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.agent_tasks(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  operation text not null check (operation in (
    'write_file', 'edit_file', 'delete_files', 'apply_patch', 'publish'
  )),
  risk_level text not null check (risk_level in ('high', 'critical')),
  title text not null check (length(title) between 1 and 500),
  reason text not null check (length(reason) between 1 and 4000),
  files text[] not null default '{}'::text[] check (
    cardinality(files) <= 100 and octet_length(files::text) <= 32768
  ),
  plan_canonical text not null check (
    length(plan_canonical) between 2 and 131072
  ),
  plan_hash bytea not null check (octet_length(plan_hash) = 32),
  token_hash bytea not null check (octet_length(token_hash) = 32),
  status text not null default 'pending' check (status in (
    'pending', 'approved', 'rejected', 'consumed', 'expired'
  )),
  resume_status text not null default 'running' check (resume_status in (
    'queued', 'planning', 'indexing', 'reading', 'editing', 'running',
    'testing', 'fixing', 'reviewing', 'waiting_for_user', 'creating_pr',
    'deploying'
  )),
  rejection_reason text check (rejection_reason is null or length(rejection_reason) <= 2000),
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  approved_at timestamptz,
  rejected_at timestamptz,
  consumed_at timestamptz,
  updated_at timestamptz not null default clock_timestamp(),
  constraint agent_confirmation_gate_expiry_check check (expires_at > created_at),
  constraint agent_confirmation_gate_terminal_timestamps_check check (
    (status <> 'approved' or approved_at is not null)
    and (status <> 'rejected' or rejected_at is not null)
    and (status <> 'consumed' or (approved_at is not null and consumed_at is not null))
  )
);

create index if not exists agent_confirmation_gates_task_created_idx
  on public.agent_confirmation_gates(task_id, created_at desc);
create index if not exists agent_confirmation_gates_expiry_idx
  on public.agent_confirmation_gates(expires_at)
  where status in ('pending', 'approved');
create unique index if not exists agent_confirmation_gates_one_active_idx
  on public.agent_confirmation_gates(task_id)
  where status in ('pending', 'approved');

alter table public.agent_confirmation_gates enable row level security;
revoke all on table public.agent_confirmation_gates
  from public, anon, authenticated, service_role;

comment on table public.agent_confirmation_gates is
  'Server-only single-use high-risk Agent approvals. Token plaintext is never persisted.';
comment on column public.agent_confirmation_gates.token_hash is
  'SHA-256 digest of the one-time 256-bit browser token.';
comment on column public.agent_confirmation_gates.plan_hash is
  'SHA-256 digest of plan_canonical, binding approval to the exact operation plan.';

create or replace function public.assert_agent_confirmation_actor(input_user_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_authenticated_user uuid := auth.uid();
  v_claim_role text := nullif(current_setting('request.jwt.claim.role', true), '');
begin
  if input_user_id is null then
    raise exception 'invalid_confirmation_actor' using errcode = '22023';
  end if;

  if v_authenticated_user is not null then
    if v_authenticated_user is distinct from input_user_id then
      raise exception 'confirmation_actor_mismatch' using errcode = '42501';
    end if;
  elsif v_claim_role is distinct from 'service_role' then
    raise exception 'confirmation_actor_missing' using errcode = '42501';
  end if;
end;
$$;

create or replace function public.agent_confirmation_result(
  input_gate public.agent_confirmation_gates
)
returns jsonb
language sql
immutable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'ok', true,
    'id', input_gate.id,
    'taskId', input_gate.task_id,
    'operation', input_gate.operation,
    'riskLevel', input_gate.risk_level,
    'title', input_gate.title,
    'reason', input_gate.reason,
    'files', to_jsonb(input_gate.files),
    'status', input_gate.status,
    'createdAt', input_gate.created_at,
    'expiresAt', input_gate.expires_at,
    'approvedAt', input_gate.approved_at,
    'rejectedAt', input_gate.rejected_at,
    'consumedAt', input_gate.consumed_at,
    'planHash', encode(input_gate.plan_hash, 'hex')
  )
$$;

create or replace function public.create_agent_confirmation_gate(
  input_user_id uuid,
  input_task_id uuid,
  input_operation text,
  input_risk_level text,
  input_title text,
  input_reason text,
  input_files text[],
  input_plan_canonical text,
  input_token_sha256 text,
  input_resume_status text default 'running',
  input_ttl_seconds integer default 600
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_gate public.agent_confirmation_gates%rowtype;
  v_plan jsonb;
  v_file text;
  v_task_repo text;
  v_task_branch text;
  v_task_has_repo boolean;
  v_task_has_branch boolean;
begin
  perform public.assert_agent_confirmation_actor(input_user_id);

  if input_task_id is null
     or input_operation not in ('write_file', 'edit_file', 'delete_files', 'apply_patch', 'publish')
     or input_risk_level <> 'high'
     or coalesce(length(input_title), 0) not between 1 and 500
     or coalesce(length(input_reason), 0) not between 1 and 4000
     or cardinality(coalesce(input_files, '{}'::text[])) > 100
     or octet_length(coalesce(input_files, '{}'::text[])::text) > 32768
     or coalesce(length(input_plan_canonical), 0) not between 2 and 131072
     or coalesce(input_token_sha256, '') !~ '^[0-9a-f]{64}$'
     or input_resume_status not in (
       'queued', 'planning', 'indexing', 'reading', 'editing', 'running',
       'testing', 'fixing', 'reviewing', 'waiting_for_user', 'creating_pr',
       'deploying'
     )
     or input_ttl_seconds not between 60 and 1800 then
    raise exception 'invalid_confirmation_request' using errcode = '22023';
  end if;

  begin
    v_plan := input_plan_canonical::jsonb;
  exception when others then
    raise exception 'invalid_confirmation_plan' using errcode = '22023';
  end;
  if jsonb_typeof(v_plan) <> 'object'
     or v_plan->>'version' <> '1'
     or v_plan->>'userId' is distinct from input_user_id::text
     or v_plan->>'taskId' is distinct from input_task_id::text
     or v_plan->>'operation' is distinct from input_operation
     or jsonb_typeof(v_plan->'files') <> 'array'
     or jsonb_typeof(v_plan->'payload') <> 'object'
     or coalesce(v_plan->>'workspaceStateSha256', '') !~ '^[0-9a-f]{64}$'
     or (v_plan->>'head' is not null and v_plan->>'head' !~ '^[0-9a-f]{40,64}$')
     or not (v_plan ? 'repo') then
    raise exception 'confirmation_plan_binding_mismatch' using errcode = '22023';
  end if;

  foreach v_file in array coalesce(input_files, '{}'::text[]) loop
    if coalesce(length(v_file), 0) not between 1 and 1000
       or v_file like '/%'
       or position(E'\\' in v_file) > 0
       or v_file ~ '(^|/)\.\.(/|$)'
       or not (v_plan->'files' ? v_file) then
      raise exception 'invalid_confirmation_file' using errcode = '22023';
    end if;
  end loop;

  select to_jsonb(task_row)->>'repo', to_jsonb(task_row)->>'branch',
         to_jsonb(task_row) ? 'repo', to_jsonb(task_row) ? 'branch'
  into v_task_repo, v_task_branch, v_task_has_repo, v_task_has_branch
  from public.agent_tasks as task_row
  where task_row.id = input_task_id and task_row.user_id = input_user_id
  for update;
  if not found then
    raise exception 'confirmation_task_not_found' using errcode = '42501';
  end if;
  if (v_task_has_repo and v_plan->>'repo' is distinct from v_task_repo)
     or (v_task_has_branch and v_task_branch is not null
         and v_plan->>'baseBranch' is distinct from v_task_branch) then
    raise exception 'confirmation_plan_authority_mismatch' using errcode = '22023';
  end if;

  update public.agent_confirmation_gates
  set status = 'expired', updated_at = v_now
  where task_id = input_task_id
    and user_id = input_user_id
    and status in ('pending', 'approved');

  insert into public.agent_confirmation_gates(
    task_id, user_id, operation, risk_level, title, reason, files,
    plan_canonical, plan_hash, token_hash, status, resume_status,
    created_at, expires_at, updated_at
  ) values (
    input_task_id, input_user_id, input_operation, input_risk_level,
    input_title, input_reason, coalesce(input_files, '{}'::text[]),
    input_plan_canonical,
    digest(convert_to(input_plan_canonical, 'UTF8'), 'sha256'),
    decode(input_token_sha256, 'hex'),
    'pending', input_resume_status, v_now,
    v_now + make_interval(secs => input_ttl_seconds), v_now
  ) returning * into v_gate;

  update public.agent_tasks
  set status = 'waiting_for_user', updated_at = v_now
  where id = input_task_id and user_id = input_user_id;

  return public.agent_confirmation_result(v_gate);
end;
$$;

create or replace function public.get_agent_confirmation_gate(
  input_user_id uuid,
  input_task_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_gate public.agent_confirmation_gates%rowtype;
begin
  perform public.assert_agent_confirmation_actor(input_user_id);

  select * into v_gate
  from public.agent_confirmation_gates
  where user_id = input_user_id and task_id = input_task_id
    and status in ('pending', 'approved')
  order by created_at desc
  limit 1
  for update;
  if not found then return null; end if;

  if v_gate.expires_at <= clock_timestamp() then
    update public.agent_confirmation_gates
    set status = 'expired', updated_at = clock_timestamp()
    where id = v_gate.id and status in ('pending', 'approved')
    returning * into v_gate;
  end if;

  return public.agent_confirmation_result(v_gate);
end;
$$;

create or replace function public.resolve_agent_confirmation_gate(
  input_user_id uuid,
  input_task_id uuid,
  input_confirmation_id uuid,
  input_operation text,
  input_token_sha256 text,
  input_action text,
  input_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_gate public.agent_confirmation_gates%rowtype;
begin
  perform public.assert_agent_confirmation_actor(input_user_id);
  if input_action not in ('confirm', 'reject')
     or input_operation not in ('write_file', 'edit_file', 'delete_files', 'apply_patch', 'publish')
     or coalesce(input_token_sha256, '') !~ '^[0-9a-f]{64}$'
     or (input_reason is not null and length(input_reason) > 2000) then
    raise exception 'invalid_confirmation_resolution' using errcode = '22023';
  end if;

  select * into v_gate
  from public.agent_confirmation_gates
  where id = input_confirmation_id
    and task_id = input_task_id
    and user_id = input_user_id
  for update;

  if not found
     or v_gate.operation is distinct from input_operation
     or v_gate.token_hash is distinct from decode(input_token_sha256, 'hex') then
    return jsonb_build_object('ok', false, 'reason', 'invalid_confirmation');
  end if;
  if v_gate.expires_at <= v_now then
    if v_gate.status in ('pending', 'approved') then
      update public.agent_confirmation_gates
      set status = 'expired', updated_at = v_now where id = v_gate.id
      returning * into v_gate;
    end if;
    return jsonb_build_object('ok', false, 'reason', 'expired');
  end if;
  if v_gate.status <> 'pending' then
    return jsonb_build_object('ok', false, 'reason', 'not_pending', 'status', v_gate.status);
  end if;

  if input_action = 'confirm' then
    update public.agent_confirmation_gates
    set status = 'approved', approved_at = v_now, updated_at = v_now
    where id = v_gate.id and status = 'pending'
    returning * into v_gate;
    update public.agent_tasks
    set status = v_gate.resume_status, updated_at = v_now
    where id = input_task_id and user_id = input_user_id
      and status = 'waiting_for_user';
  else
    update public.agent_confirmation_gates
    set status = 'rejected', rejected_at = v_now,
        rejection_reason = nullif(input_reason, ''), updated_at = v_now
    where id = v_gate.id and status = 'pending'
    returning * into v_gate;
  end if;

  return public.agent_confirmation_result(v_gate);
end;
$$;

create or replace function public.consume_agent_confirmation_gate(
  input_user_id uuid,
  input_task_id uuid,
  input_confirmation_id uuid,
  input_operation text,
  input_plan_canonical text,
  input_token_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_gate public.agent_confirmation_gates%rowtype;
  v_plan_hash bytea;
begin
  perform public.assert_agent_confirmation_actor(input_user_id);
  if input_operation not in ('write_file', 'edit_file', 'delete_files', 'apply_patch', 'publish')
     or coalesce(length(input_plan_canonical), 0) not between 2 and 131072
     or coalesce(input_token_sha256, '') !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_confirmation_consumption' using errcode = '22023';
  end if;
  v_plan_hash := digest(convert_to(input_plan_canonical, 'UTF8'), 'sha256');

  select * into v_gate
  from public.agent_confirmation_gates
  where id = input_confirmation_id
    and task_id = input_task_id
    and user_id = input_user_id
  for update;

  if not found
     or v_gate.operation is distinct from input_operation
     or v_gate.token_hash is distinct from decode(input_token_sha256, 'hex') then
    return jsonb_build_object('ok', false, 'reason', 'invalid_confirmation');
  end if;
  if v_gate.expires_at <= v_now then
    if v_gate.status in ('pending', 'approved') then
      update public.agent_confirmation_gates
      set status = 'expired', updated_at = v_now where id = v_gate.id;
    end if;
    return jsonb_build_object('ok', false, 'reason', 'expired');
  end if;
  if v_gate.plan_hash is distinct from v_plan_hash
     or v_gate.plan_canonical is distinct from input_plan_canonical then
    return jsonb_build_object('ok', false, 'reason', 'plan_mismatch');
  end if;
  if v_gate.status <> 'approved' then
    return jsonb_build_object('ok', false, 'reason',
      case when v_gate.status = 'consumed' then 'already_consumed' else 'not_approved' end,
      'status', v_gate.status
    );
  end if;

  update public.agent_confirmation_gates
  set status = 'consumed', consumed_at = v_now, updated_at = v_now
  where id = v_gate.id and status = 'approved'
  returning * into v_gate;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'already_consumed');
  end if;
  return public.agent_confirmation_result(v_gate);
end;
$$;

revoke all on function public.assert_agent_confirmation_actor(uuid) from public, anon, authenticated, service_role;
revoke all on function public.agent_confirmation_result(public.agent_confirmation_gates) from public, anon, authenticated, service_role;
revoke all on function public.create_agent_confirmation_gate(uuid,uuid,text,text,text,text,text[],text,text,text,integer) from public, anon;
revoke all on function public.get_agent_confirmation_gate(uuid,uuid) from public, anon;
revoke all on function public.resolve_agent_confirmation_gate(uuid,uuid,uuid,text,text,text,text) from public, anon;
revoke all on function public.consume_agent_confirmation_gate(uuid,uuid,uuid,text,text,text) from public, anon;

grant execute on function public.create_agent_confirmation_gate(uuid,uuid,text,text,text,text,text[],text,text,text,integer)
  to authenticated, service_role;
grant execute on function public.get_agent_confirmation_gate(uuid,uuid)
  to authenticated, service_role;
grant execute on function public.resolve_agent_confirmation_gate(uuid,uuid,uuid,text,text,text,text)
  to authenticated, service_role;
grant execute on function public.consume_agent_confirmation_gate(uuid,uuid,uuid,text,text,text)
  to authenticated, service_role;

commit;
