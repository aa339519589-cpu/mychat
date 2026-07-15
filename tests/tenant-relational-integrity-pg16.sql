\set ON_ERROR_STOP on

-- A failed concurrent build leaves a same-named INVALID catalog row. Prepare a
-- second same-tenant row in its own transaction so this fault injection does
-- not depend on fixtures owned by an earlier migration test.
begin;
insert into public.project_files(id, project_id, user_id, name, content)
select
  'a7fe0000-0000-4000-8000-000000000001',
  project_id,
  user_id,
  'invalid-index-fixture.txt',
  'temporary duplicate-key fault injection'
from public.project_files
order by id
limit 1
on conflict (id) do nothing;
do $$
begin
  if (select count(*) from public.project_files) < 2 then
    raise exception 'invalid-index fault injection requires two Project files';
  end if;
end;
$$;
commit;

-- Prove the migration rejects the failed build before reaching even its first
-- CREATE INDEX: remove a later candidate as a canary, run the real migration in
-- a child psql, and require the dedicated error and still-absent canary.

drop index concurrently public.project_files_tenant_id_uidx;
drop index concurrently public.code_messages_tenant_id_uidx;

\set ON_ERROR_STOP off
create unique index concurrently project_files_tenant_id_uidx
  on public.project_files ((true));
\set invalid_build_sqlstate :SQLSTATE
\set ON_ERROR_STOP on

select 1 / case when :'invalid_build_sqlstate' = '23505' then 1 else 0 end;
do $$
begin
  if not exists (
    select 1
    from pg_index as installed_index
    where installed_index.indexrelid = 'public.project_files_tenant_id_uidx'::regclass
      and (not installed_index.indisvalid or not installed_index.indisready)
  ) then
    raise exception 'fault injection did not leave an unusable concurrent index';
  end if;
  if to_regclass('public.code_messages_tenant_id_uidx') is not null then
    raise exception 'preflight DDL canary was not removed';
  end if;
end;
$$;

\setenv PGDATABASE :DBNAME
\setenv PGHOST :HOST
\setenv PGPORT :PORT
\setenv PGUSER :USER
\! psql -X -v ON_ERROR_STOP=1 -f supabase/migrations/20260713270000_tenant_relational_integrity.sql >/tmp/mychat-tenant-index-preflight.log 2>&1
\if :SHELL_ERROR
\else
  select 1 / 0;
\endif
\! grep -q 'tenant_candidate_index_unusable: project_files_tenant_id_uidx' /tmp/mychat-tenant-index-preflight.log
\if :SHELL_ERROR
  select 1 / 0;
\endif

do $$
begin
  if to_regclass('public.code_messages_tenant_id_uidx') is not null then
    raise exception 'tenant migration executed DDL after a poisoned-index preflight';
  end if;
  if not exists (
    select 1
    from pg_index as installed_index
    where installed_index.indexrelid = 'public.project_files_tenant_id_uidx'::regclass
      and (not installed_index.indisvalid or not installed_index.indisready)
  ) then
    raise exception 'tenant migration modified the poisoned index automatically';
  end if;
end;
$$;

\! rm -f /tmp/mychat-tenant-index-preflight.log
drop index concurrently public.project_files_tenant_id_uidx;
begin;
delete from public.project_files
where id = 'a7fe0000-0000-4000-8000-000000000001';
commit;
\ir ../supabase/migrations/20260713270000_tenant_relational_integrity.sql
\ir ../supabase/migrations/20260713270000_tenant_relational_integrity.sql

begin;

do $$
declare
  expected_indexes text[] := array[
    'projects_tenant_id_uidx',
    'project_files_tenant_id_uidx',
    'project_memories_tenant_id_uidx',
    'conversations_tenant_id_uidx',
    'messages_tenant_id_uidx',
    'messages_tenant_conversation_id_uidx',
    'code_sessions_tenant_id_uidx',
    'code_messages_tenant_id_uidx',
    'conversation_chunks_tenant_id_uidx',
    'artifacts_tenant_id_uidx',
    'chat_generations_tenant_id_uidx',
    'agent_tasks_tenant_id_uidx',
    'agent_task_steps_tenant_id_uidx',
    'agent_task_steps_tenant_task_id_uidx',
    'agent_tool_calls_tenant_id_uidx',
    'agent_workspaces_tenant_id_uidx',
    'agent_artifacts_tenant_id_uidx',
    'agent_confirmation_gates_tenant_id_uidx',
    'jobs_principal_id_uidx',
    'ledger_entries_principal_id_uidx'
  ];
  expected_constraints text[] := array[
    'project_files_tenant_project_fkey',
    'project_memories_tenant_project_fkey',
    'conversations_tenant_project_fkey',
    'messages_tenant_conversation_fkey',
    'conversations_tenant_summary_message_fkey',
    'code_messages_tenant_session_fkey',
    'conversation_chunks_tenant_conversation_fkey',
    'conversation_chunks_tenant_project_fkey',
    'conversation_chunks_tenant_message_start_fkey',
    'conversation_chunks_tenant_message_end_fkey',
    'artifacts_tenant_conversation_fkey',
    'artifacts_tenant_message_fkey',
    'artifacts_conversation_message_fkey',
    'artifacts_tenant_project_fkey',
    'chat_generations_tenant_conversation_fkey',
    'chat_generations_tenant_assistant_message_fkey',
    'messages_tenant_generation_fkey',
    'agent_task_steps_tenant_task_fkey',
    'agent_tool_calls_tenant_task_fkey',
    'agent_tool_calls_tenant_task_step_fkey',
    'agent_workspaces_tenant_task_fkey',
    'agent_artifacts_tenant_task_fkey',
    'agent_confirmation_gates_tenant_task_fkey',
    'agent_workspace_heads_tenant_task_fkey',
    'agent_workspace_heads_tenant_job_fkey',
    'job_events_tenant_job_fkey',
    'job_checkpoints_tenant_job_fkey',
    'job_tool_effects_tenant_job_fkey',
    'job_outbox_job_principal_fkey',
    'job_assets_job_principal_fkey',
    'ledger_entries_tenant_job_fkey',
    'ledger_balance_settlements_tenant_entry_fkey',
    'audit_log_tenant_job_fkey',
    'job_admission_reservations_tenant_job_fkey',
    'jobs_tenant_confirmation_fkey'
  ];
  legacy_constraints text[] := array[
    'project_files_project_id_fkey',
    'project_memories_project_id_fkey',
    'conversations_project_id_fkey',
    'conversations_summary_until_message_id_fkey',
    'messages_conversation_id_fkey',
    'messages_generation_id_fkey',
    'code_messages_session_id_fkey',
    'conversation_chunks_conversation_id_fkey',
    'conversation_chunks_project_id_fkey',
    'conversation_chunks_message_start_id_fkey',
    'conversation_chunks_message_end_id_fkey',
    'artifacts_conversation_id_fkey',
    'artifacts_message_id_fkey',
    'artifacts_project_id_fkey',
    'chat_generations_conversation_id_fkey',
    'chat_generations_assistant_message_fkey',
    'agent_task_steps_task_id_fkey',
    'agent_tool_calls_task_id_fkey',
    'agent_tool_calls_step_id_fkey',
    'agent_workspaces_task_id_fkey',
    'agent_artifacts_task_id_fkey',
    'agent_confirmation_gates_task_id_fkey',
    'agent_workspace_heads_task_id_fkey',
    'agent_workspace_heads_job_id_fkey',
    'job_events_job_id_fkey',
    'job_checkpoints_job_id_fkey',
    'job_tool_effects_job_id_fkey',
    'job_outbox_job_id_fkey',
    'job_assets_job_id_fkey',
    'ledger_entries_job_id_fkey',
    'ledger_balance_settlements_ledger_entry_id_fkey',
    'job_admission_reservations_job_fk',
    'jobs_confirmation_id_fkey'
  ];
begin
  if (
    select count(*)
    from pg_index as installed_index
    join pg_class as index_relation on index_relation.oid = installed_index.indexrelid
    where index_relation.relname = any(expected_indexes)
      and installed_index.indisunique
      and installed_index.indisvalid
      and installed_index.indisready
  ) <> cardinality(expected_indexes) then
    raise exception 'one or more concurrent tenant candidate indexes are absent or invalid';
  end if;
  if (
    select count(*) from pg_constraint
    where conname = any(expected_constraints) and contype = 'f' and convalidated
  ) <> cardinality(expected_constraints) then
    raise exception 'one or more tenant ownership FKs are absent or unvalidated';
  end if;
  if (
    select count(*) from pg_constraint
    where connamespace = 'public'::regnamespace
      and conname = any(legacy_constraints)
      and contype = 'f'
      and convalidated
  ) <> cardinality(legacy_constraints) then
    raise exception 'expand release removed or invalidated a legacy FK';
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'audit_log_job_id_fkey' and contype = 'f' and convalidated
  ) then
    raise exception 'principal-less audit rows lost their job existence FK';
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'conversations_tenant_project_fkey'
      and pg_get_constraintdef(oid) like '%ON DELETE SET NULL (project_id)%'
  ) or not exists (
    select 1 from pg_constraint
    where conname = 'conversations_tenant_summary_message_fkey'
      and pg_get_constraintdef(oid) like '%ON DELETE SET NULL (summary_until_message_id)%'
  ) or not exists (
    select 1 from pg_constraint
    where conname = 'agent_tool_calls_tenant_task_step_fkey'
      and pg_get_constraintdef(oid) like '%ON DELETE SET NULL (step_id)%'
  ) or not exists (
    select 1 from pg_constraint
    where conname = 'messages_tenant_generation_fkey'
      and pg_get_constraintdef(oid) like '%ON DELETE SET NULL (generation_id)%'
  ) then
    raise exception 'column-specific SET NULL semantics were not installed';
  end if;
end;
$$;

insert into public.projects(id, user_id, name) values
  ('a7000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'tenant one'),
  ('a7000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000002', 'tenant two');

insert into public.conversations(id, user_id, project_id) values
  ('a7010000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001'),
  ('a7010000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', null),
  ('a7010000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000002', 'a7000000-0000-4000-8000-000000000002');

insert into public.messages(id, conversation_id, user_id, role, content) values
  ('a7020000-0000-4000-8000-000000000001', 'a7010000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'user', 'first boundary'),
  ('a7020000-0000-4000-8000-000000000002', 'a7010000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'assistant', 'last boundary'),
  ('a7020000-0000-4000-8000-000000000003', 'a7010000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', 'user', 'other conversation'),
  ('a7020000-0000-4000-8000-000000000004', 'a7010000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000002', 'user', 'other tenant'),
  ('a7020000-0000-4000-8000-000000000005', 'a7010000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'assistant', 'summary boundary');

insert into public.project_files(id, project_id, user_id, name, content) values (
  'a7030000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000001', 'tenant.txt', 'owned content'
);
insert into public.project_memories(id, project_id, user_id, content) values (
  'a7040000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000001', 'owned memory'
);
insert into public.conversation_chunks(
  id, user_id, conversation_id, project_id, message_start_id, message_end_id,
  content, content_hash
) values (
  'a7050000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001',
  'a7010000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001',
  'a7020000-0000-4000-8000-000000000001', 'a7020000-0000-4000-8000-000000000002',
  'owned chunk', repeat('a', 64)
);
insert into public.artifacts(
  id, user_id, conversation_id, message_id, project_id, title, raw
) values (
  'a7060000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001',
  'a7010000-0000-4000-8000-000000000001', null, 'a7000000-0000-4000-8000-000000000001',
  'owned artifact', '<p>owned</p>'
);

do $$
begin
  begin
    insert into public.project_files(id, project_id, user_id, name, content) values (
      'a7100000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000002',
      '00000000-0000-4000-8000-000000000001', 'cross-tenant.txt', 'must fail'
    );
    raise exception 'cross-tenant Project file was accepted';
  exception when foreign_key_violation then null;
  end;

  begin
    insert into public.messages(id, conversation_id, user_id, role, content) values (
      'a7100000-0000-4000-8000-000000000002', 'a7010000-0000-4000-8000-000000000003',
      '00000000-0000-4000-8000-000000000001', 'user', 'must fail'
    );
    raise exception 'cross-tenant Message was accepted';
  exception when foreign_key_violation then null;
  end;

  begin
    update public.conversations
    set summary_until_message_id = 'a7020000-0000-4000-8000-000000000003'
    where id = 'a7010000-0000-4000-8000-000000000001';
    raise exception 'cross-conversation summary boundary was accepted';
  exception when foreign_key_violation then null;
  end;

  begin
    insert into public.conversation_chunks(
      id, user_id, conversation_id, message_start_id, content, content_hash
    ) values (
      'a7100000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000001',
      'a7010000-0000-4000-8000-000000000001', 'a7020000-0000-4000-8000-000000000003',
      'must fail', repeat('b', 64)
    );
    raise exception 'cross-conversation Chunk boundary was accepted';
  exception when foreign_key_violation then null;
  end;

  begin
    insert into public.artifacts(
      id, user_id, conversation_id, message_id, title, raw
    ) values (
      'a7100000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000001',
      'a7010000-0000-4000-8000-000000000001', 'a7020000-0000-4000-8000-000000000003',
      'must fail', '<p>must fail</p>'
    );
    raise exception 'cross-conversation Artifact message was accepted';
  exception when foreign_key_violation then null;
  end;
end;
$$;

insert into public.code_sessions(id, user_id, repo) values
  ('a7200000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'owner/one'),
  ('a7200000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000002', 'owner/two');
insert into public.code_messages(id, session_id, user_id, role, content) values (
  'a7210000-0000-4000-8000-000000000001', 'a7200000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000001', 'user', 'owned code message'
);
do $$
begin
  begin
    insert into public.code_messages(id, session_id, user_id, role, content) values (
      'a7210000-0000-4000-8000-000000000002', 'a7200000-0000-4000-8000-000000000002',
      '00000000-0000-4000-8000-000000000001', 'user', 'must fail'
    );
    raise exception 'cross-tenant Code message was accepted';
  exception when foreign_key_violation then null;
  end;
end;
$$;

insert into public.agent_tasks(id, user_id, goal) values
  ('a7300000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'tenant task one'),
  ('a7300000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', 'tenant task two'),
  ('a7300000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000002', 'tenant task three');
insert into public.agent_task_steps(id, task_id, user_id, kind, label) values
  ('a7310000-0000-4000-8000-000000000001', 'a7300000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'info', 'owned step'),
  ('a7310000-0000-4000-8000-000000000002', 'a7300000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', 'info', 'other task step');
insert into public.agent_tool_calls(id, task_id, user_id, step_id, tool_name) values (
  'a7320000-0000-4000-8000-000000000001', 'a7300000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000001', 'a7310000-0000-4000-8000-000000000001', 'read_file'
);
do $$
begin
  begin
    insert into public.agent_task_steps(id, task_id, user_id, kind) values (
      'a7390000-0000-4000-8000-000000000001', 'a7300000-0000-4000-8000-000000000003',
      '00000000-0000-4000-8000-000000000001', 'info'
    );
    raise exception 'cross-tenant Agent step was accepted';
  exception when foreign_key_violation then null;
  end;

  begin
    insert into public.agent_tool_calls(id, task_id, user_id, step_id, tool_name) values (
      'a7390000-0000-4000-8000-000000000002', 'a7300000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000001', 'a7310000-0000-4000-8000-000000000002', 'read_file'
    );
    raise exception 'cross-task Agent step binding was accepted';
  exception when foreign_key_violation then null;
  end;
end;
$$;

do $$
begin
  begin
    insert into public.job_events(job_id, principal_id, seq, kind) values (
      '83000000-0000-4000-8000-000000000005', '00000000-0000-4000-8000-000000000001',
      999999, 'tests.tenant'
    );
    raise exception 'cross-tenant Job event was accepted';
  exception when foreign_key_violation then null;
  end;
end;
$$;

update public.conversations
set summary_until_message_id = 'a7020000-0000-4000-8000-000000000005'
where id = 'a7010000-0000-4000-8000-000000000001';

delete from public.projects where id = 'a7000000-0000-4000-8000-000000000001';
do $$
begin
  if exists (
    select 1 from public.project_files where id = 'a7030000-0000-4000-8000-000000000001'
  ) or exists (
    select 1 from public.project_memories where id = 'a7040000-0000-4000-8000-000000000001'
  ) then
    raise exception 'Project-owned rows did not cascade';
  end if;
  if not exists (
    select 1 from public.conversations
    where id = 'a7010000-0000-4000-8000-000000000001'
      and user_id = '00000000-0000-4000-8000-000000000001' and project_id is null
  ) or not exists (
    select 1 from public.conversation_chunks
    where id = 'a7050000-0000-4000-8000-000000000001'
      and user_id = '00000000-0000-4000-8000-000000000001' and project_id is null
  ) or not exists (
    select 1 from public.artifacts
    where id = 'a7060000-0000-4000-8000-000000000001'
      and user_id = '00000000-0000-4000-8000-000000000001' and project_id is null
  ) then
    raise exception 'Project deletion cleared tenant identity or deleted nullable children';
  end if;
end;
$$;

delete from public.messages where id = 'a7020000-0000-4000-8000-000000000005';
delete from public.messages where id = 'a7020000-0000-4000-8000-000000000001';
delete from public.messages where id = 'a7020000-0000-4000-8000-000000000002';
do $$
begin
  if (select summary_until_message_id is not null from public.conversations
      where id = 'a7010000-0000-4000-8000-000000000001') then
    raise exception 'summary boundary was not set null';
  end if;
  if not exists (
    select 1 from public.conversation_chunks
    where id = 'a7050000-0000-4000-8000-000000000001'
      and user_id = '00000000-0000-4000-8000-000000000001'
      and message_start_id is null and message_end_id is null
  ) then
    raise exception 'Chunk message bounds did not clear only their relationship columns';
  end if;
end;
$$;

delete from public.agent_task_steps where id = 'a7310000-0000-4000-8000-000000000001';
do $$
begin
  if not exists (
    select 1 from public.agent_tool_calls
    where id = 'a7320000-0000-4000-8000-000000000001'
      and user_id = '00000000-0000-4000-8000-000000000001'
      and task_id = 'a7300000-0000-4000-8000-000000000001'
      and step_id is null
  ) then
    raise exception 'Step deletion damaged Tool-call tenant/task identity';
  end if;
end;
$$;

-- The expand release deliberately retains the legacy NO ACTION FK alongside
-- the tenant-aware CASCADE FK. Clean up in dependency order until a later
-- contract migration removes that redundant legacy constraint.
delete from public.code_messages where id = 'a7210000-0000-4000-8000-000000000001';
delete from public.code_sessions where id = 'a7200000-0000-4000-8000-000000000001';

rollback;
