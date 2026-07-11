-- Backend integrity hardening: reconcile legacy schemas, make redemption atomic,
-- and ensure child rows can only reference parents owned by the same user.

alter table public.project_memories add column if not exists updated_at timestamptz default now();
alter table public.code_messages add column if not exists meta jsonb;

-- Reconcile the legacy artifacts(html) table with the current artifacts(raw) model.
alter table public.artifacts add column if not exists message_id uuid references public.messages(id) on delete cascade;
alter table public.artifacts add column if not exists project_id uuid references public.projects(id) on delete set null;
alter table public.artifacts add column if not exists raw text;
alter table public.artifacts add column if not exists updated_at timestamptz default now();
do $$ begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'artifacts' and column_name = 'html'
  ) then
    execute 'update public.artifacts set raw = coalesce(raw, html, '''') where raw is null';
    execute 'alter table public.artifacts alter column html drop not null';
  else
    update public.artifacts set raw = '' where raw is null;
  end if;
end $$;
alter table public.artifacts alter column raw set default '';
alter table public.artifacts alter column raw set not null;
create unique index if not exists artifacts_message_unique_idx on public.artifacts(message_id) where message_id is not null;

alter table public.conversation_chunks drop constraint if exists conversation_chunks_user_id_content_hash_key;
drop index if exists public.conversation_chunks_user_id_content_hash_key;
create unique index if not exists conversation_chunks_conversation_hash_unique_idx
  on public.conversation_chunks(conversation_id, content_hash);

-- New Agent events use a database sequence so concurrent workers never reuse max(seq)+1.
create sequence if not exists public.agent_event_seq;
alter table public.agent_task_steps alter column seq set default nextval('public.agent_event_seq');
alter table public.agent_tool_calls alter column seq set default nextval('public.agent_event_seq');
grant usage, select on sequence public.agent_event_seq to authenticated;

-- One task owns at most one workspace. Keep the newest row if legacy data contains duplicates.
delete from public.agent_workspaces older
using public.agent_workspaces newer
where older.task_id = newer.task_id
  and (older.updated_at, older.id) < (newer.updated_at, newer.id);
create unique index if not exists agent_workspaces_task_unique_idx on public.agent_workspaces(task_id);

-- Atomic, race-safe invitation redemption. The code itself stays unreadable under RLS.
create or replace function public.redeem_invitation_code(input_code text)
returns table(tokens_added bigint, new_balance bigint)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_user_id uuid := auth.uid();
  code_row public.invitation_codes%rowtype;
begin
  if current_user_id is null then raise exception 'not_authenticated' using errcode = 'P0001'; end if;
  if input_code is null or length(trim(input_code)) < 8 or length(trim(input_code)) > 128 then
    raise exception 'invalid_or_used' using errcode = 'P0001';
  end if;
  select * into code_row
  from public.invitation_codes
  where code = trim(input_code) and used_by is null
  for update;
  if not found then raise exception 'invalid_or_used' using errcode = 'P0001'; end if;

  update public.invitation_codes
  set used_by = current_user_id, used_at = now()
  where id = code_row.id and used_by is null;
  if not found then raise exception 'invalid_or_used' using errcode = 'P0001'; end if;

  insert into public.profiles(user_id, balance)
  values (current_user_id, code_row.tokens)
  on conflict (user_id) do update
    set balance = coalesce(public.profiles.balance, 0) + excluded.balance
  returning balance into new_balance;
  tokens_added := code_row.tokens;
  return next;
end;
$$;
revoke all on function public.redeem_invitation_code(text) from public;
grant execute on function public.redeem_invitation_code(text) to authenticated;

create or replace function public.record_quota_usage(weighted_tokens bigint, use_balance boolean default false)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_user_id uuid := auth.uid();
  amount bigint := greatest(coalesce(weighted_tokens, 0), 0);
begin
  if current_user_id is null then raise exception 'not_authenticated' using errcode = 'P0001'; end if;
  if amount > 100000000 then raise exception 'invalid_token_amount' using errcode = 'P0001'; end if;
  if amount = 0 then return; end if;
  insert into public.profiles(user_id) values (current_user_id) on conflict (user_id) do nothing;
  update public.profiles
  set
    tokens_5h = (case when window_5h_start is null or window_5h_start <= now() - interval '5 hours' then 0 else coalesce(tokens_5h, 0) end) + amount,
    window_5h_start = case when window_5h_start is null or window_5h_start <= now() - interval '5 hours' then now() else window_5h_start end,
    tokens_7d = (case when window_7d_start is null or window_7d_start <= now() - interval '7 days' then 0 else coalesce(tokens_7d, 0) end) + amount,
    window_7d_start = case when window_7d_start is null or window_7d_start <= now() - interval '7 days' then now() else window_7d_start end,
    balance = case when use_balance then greatest(coalesce(balance, 0) - amount, 0) else coalesce(balance, 0) end,
    quota_version = coalesce(quota_version, 0) + 1
  where user_id = current_user_id;
end;
$$;
revoke all on function public.record_quota_usage(bigint, boolean) from public;
grant execute on function public.record_quota_usage(bigint, boolean) to authenticated;

create or replace function public.merge_agent_task_meta(
  input_task_id uuid,
  patch jsonb default '{}'::jsonb,
  remove_keys text[] default '{}'::text[]
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare merged jsonb;
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode = 'P0001'; end if;
  if octet_length(coalesce(patch, '{}'::jsonb)::text) > 2097152
     or coalesce(array_length(remove_keys, 1), 0) > 100 then
    raise exception 'meta_patch_too_large' using errcode = 'P0001';
  end if;
  update public.agent_tasks
  set meta = (coalesce(meta, '{}'::jsonb) - remove_keys) || coalesce(patch, '{}'::jsonb),
      updated_at = now()
  where id = input_task_id and user_id = auth.uid()
  returning meta into merged;
  if merged is null then raise exception 'task_not_found' using errcode = 'P0001'; end if;
  return merged;
end;
$$;
revoke all on function public.merge_agent_task_meta(uuid, jsonb, text[]) from public;
grant execute on function public.merge_agent_task_meta(uuid, jsonb, text[]) to authenticated;

create or replace function public.merge_agent_run_state(input_task_id uuid, patch jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare merged jsonb;
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode = 'P0001'; end if;
  if octet_length(coalesce(patch, '{}'::jsonb)::text) > 1048576 then
    raise exception 'run_state_too_large' using errcode = 'P0001';
  end if;
  update public.agent_tasks
  set meta = jsonb_set(
        coalesce(meta, '{}'::jsonb),
        '{agentRun}',
        coalesce(meta->'agentRun', '{}'::jsonb) || coalesce(patch, '{}'::jsonb),
        true
      ),
      updated_at = now()
  where id = input_task_id and user_id = auth.uid()
  returning meta->'agentRun' into merged;
  if merged is null then raise exception 'task_not_found' using errcode = 'P0001'; end if;
  return merged;
end;
$$;
revoke all on function public.merge_agent_run_state(uuid, jsonb) from public;
grant execute on function public.merge_agent_run_state(uuid, jsonb) to authenticated;

create or replace function public.claim_agent_run(input_task_id uuid, input_run_id text, lease_seconds integer default 120)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare affected integer;
begin
  if auth.uid() is null or input_run_id is null or length(input_run_id) > 128 then return false; end if;
  update public.agent_tasks
  set meta = coalesce(meta, '{}'::jsonb) || jsonb_build_object(
        'activeRunId', input_run_id,
        'runLeaseUntil', now() + make_interval(secs => greatest(30, least(coalesce(lease_seconds, 120), 600))),
        'runLeaseUntilEpoch', extract(epoch from now()) + greatest(30, least(coalesce(lease_seconds, 120), 600))
      ),
      updated_at = now()
  where id = input_task_id
    and user_id = auth.uid()
    and status not in ('completed', 'cancelled')
    and (
      meta->>'activeRunId' = input_run_id
      or jsonb_typeof(meta->'runLeaseUntilEpoch') is distinct from 'number'
      or (meta->>'runLeaseUntilEpoch')::numeric <= extract(epoch from now())
    );
  get diagnostics affected = row_count;
  return affected > 0;
end;
$$;

create or replace function public.renew_agent_run(input_task_id uuid, input_run_id text, lease_seconds integer default 120)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare affected integer;
begin
  if auth.uid() is null or input_run_id is null or length(input_run_id) > 128 then return false; end if;
  update public.agent_tasks
  set meta = jsonb_set(
        jsonb_set(coalesce(meta, '{}'::jsonb), '{runLeaseUntil}', to_jsonb(now() + make_interval(secs => greatest(30, least(coalesce(lease_seconds, 120), 600)))), true),
        '{runLeaseUntilEpoch}',
        to_jsonb(extract(epoch from now()) + greatest(30, least(coalesce(lease_seconds, 120), 600))),
        true
      ),
      updated_at = now()
  where id = input_task_id and user_id = auth.uid()
    and meta->>'activeRunId' = input_run_id
    and status not in ('completed', 'failed', 'cancelled');
  get diagnostics affected = row_count;
  return affected > 0;
end;
$$;

create or replace function public.release_agent_run(input_task_id uuid, input_run_id text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null or input_run_id is null or length(input_run_id) > 128 then return; end if;
  update public.agent_tasks
  set meta = coalesce(meta, '{}'::jsonb) - array['activeRunId', 'runLeaseUntil', 'runLeaseUntilEpoch'], updated_at = now()
  where id = input_task_id and user_id = auth.uid() and meta->>'activeRunId' = input_run_id;
end;
$$;

revoke all on function public.claim_agent_run(uuid, text, integer) from public;
revoke all on function public.renew_agent_run(uuid, text, integer) from public;
revoke all on function public.release_agent_run(uuid, text) from public;
grant execute on function public.claim_agent_run(uuid, text, integer) to authenticated;
grant execute on function public.renew_agent_run(uuid, text, integer) to authenticated;
grant execute on function public.release_agent_run(uuid, text) to authenticated;

-- Clients may change profile preferences, but quota and balance are server-owned.
revoke insert, update on public.profiles from authenticated;
grant insert (user_id, memory_enabled, custom_system_prompt) on public.profiles to authenticated;
grant update (memory_enabled, custom_system_prompt) on public.profiles to authenticated;

-- Child ownership policies: user_id equality alone allowed cross-parent references.
drop policy if exists "messages_insert" on public.messages;
drop policy if exists "messages_update" on public.messages;
create policy "messages_insert" on public.messages for insert with check (
  auth.uid() = user_id and exists (
    select 1 from public.conversations p where p.id = conversation_id and p.user_id = auth.uid()
  )
);
create policy "messages_update" on public.messages for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id and exists (
    select 1 from public.conversations p where p.id = conversation_id and p.user_id = auth.uid()
  ));

drop policy if exists "codes_read" on public.invitation_codes;
drop policy if exists "codes_redeem" on public.invitation_codes;
create policy "codes_read_own" on public.invitation_codes for select using (
  created_by = auth.uid() or used_by = auth.uid()
);

drop policy if exists "project_files_insert" on public.project_files;
create policy "project_files_insert" on public.project_files for insert with check (
  auth.uid() = user_id and exists (
    select 1 from public.projects p where p.id = project_id and p.user_id = auth.uid()
  )
);

drop policy if exists "project_memories_insert" on public.project_memories;
drop policy if exists "users manage own project memories" on public.project_memories;
create policy "project_memories_insert" on public.project_memories for insert with check (
  auth.uid() = user_id and exists (
    select 1 from public.projects p where p.id = project_id and p.user_id = auth.uid()
  )
);
drop policy if exists "project_memories_select" on public.project_memories;
create policy "project_memories_select" on public.project_memories for select using (auth.uid() = user_id);
drop policy if exists "project_memories_update" on public.project_memories;
create policy "project_memories_update" on public.project_memories for update using (auth.uid() = user_id)
  with check (auth.uid() = user_id and exists (
    select 1 from public.projects p where p.id = project_id and p.user_id = auth.uid()
  ));
drop policy if exists "project_memories_delete" on public.project_memories;
create policy "project_memories_delete" on public.project_memories for delete using (auth.uid() = user_id);

drop policy if exists "code_messages_insert" on public.code_messages;
drop policy if exists "code_messages_insert_own" on public.code_messages;
create policy "code_messages_insert_own" on public.code_messages for insert with check (
  auth.uid() = user_id and exists (
    select 1 from public.code_sessions p where p.id = session_id and p.user_id = auth.uid()
  )
);

drop policy if exists "artifacts_insert" on public.artifacts;
drop policy if exists "artifacts_insert_own" on public.artifacts;
create policy "artifacts_insert_own" on public.artifacts for insert with check (
  auth.uid() = user_id
  and (conversation_id is null or exists (
    select 1 from public.conversations p where p.id = conversation_id and p.user_id = auth.uid()
  ))
  and (project_id is null or exists (
    select 1 from public.projects p where p.id = project_id and p.user_id = auth.uid()
  ))
);

drop policy if exists conversation_chunks_insert_own on public.conversation_chunks;
create policy conversation_chunks_insert_own on public.conversation_chunks for insert with check (
  auth.uid() = user_id and exists (
    select 1 from public.conversations p where p.id = conversation_id and p.user_id = auth.uid()
  ) and (project_id is null or exists (
    select 1 from public.projects p where p.id = project_id and p.user_id = auth.uid()
  ))
);

drop policy if exists "agent_steps_insert" on public.agent_task_steps;
create policy "agent_steps_insert" on public.agent_task_steps for insert with check (
  auth.uid() = user_id and exists (
    select 1 from public.agent_tasks p where p.id = task_id and p.user_id = auth.uid()
  )
);
drop policy if exists "agent_tool_calls_insert" on public.agent_tool_calls;
create policy "agent_tool_calls_insert" on public.agent_tool_calls for insert with check (
  auth.uid() = user_id and exists (
    select 1 from public.agent_tasks p where p.id = task_id and p.user_id = auth.uid()
  )
);
drop policy if exists "agent_tool_calls_update" on public.agent_tool_calls;
create policy "agent_tool_calls_update" on public.agent_tool_calls for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id and exists (
    select 1 from public.agent_tasks p where p.id = task_id and p.user_id = auth.uid()
  ));
drop policy if exists "agent_workspaces_insert" on public.agent_workspaces;
create policy "agent_workspaces_insert" on public.agent_workspaces for insert with check (
  auth.uid() = user_id and exists (
    select 1 from public.agent_tasks p where p.id = task_id and p.user_id = auth.uid()
  )
);
drop policy if exists "agent_workspaces_update" on public.agent_workspaces;
create policy "agent_workspaces_update" on public.agent_workspaces for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id and exists (
    select 1 from public.agent_tasks p where p.id = task_id and p.user_id = auth.uid()
  ));
drop policy if exists "agent_artifacts_insert" on public.agent_artifacts;
create policy "agent_artifacts_insert" on public.agent_artifacts for insert with check (
  auth.uid() = user_id and exists (
    select 1 from public.agent_tasks p where p.id = task_id and p.user_id = auth.uid()
  )
);
