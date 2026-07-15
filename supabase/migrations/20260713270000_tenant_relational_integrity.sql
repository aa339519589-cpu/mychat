-- Tenant ownership must be part of every relationship between tenant rows.
-- RLS protects query paths, while these keys protect privileged workers,
-- SECURITY DEFINER functions, imports, and future code from cross-tenant joins.
--
-- This file deliberately has no encompassing transaction. It must be run by an
-- autocommit client (the production runbook and PG16 harness use psql -f):
-- candidate keys are built concurrently, and every metadata lock is acquired in
-- its own short transaction. A lock timeout stops the rollout instead of
-- queueing application writes behind migration DDL; rerunning resumes safely.
set lock_timeout = '5s';
set statement_timeout = '30min';

-- CREATE INDEX CONCURRENTLY can leave a same-named INVALID index after a
-- cancellation, uniqueness failure, or crash. IF NOT EXISTS would silently
-- accept that tombstone, so reject every unusable or structurally unexpected
-- candidate before this migration performs any DDL. Recovery is deliberately
-- operator-owned: inspect the failed build, then DROP INDEX CONCURRENTLY and
-- replay this migration. Never drop an unknown catalog object automatically.
do $$
declare
  unusable_indexes text;
begin
  with expected(index_name, table_id, key_columns) as (
    values
      ('projects_tenant_id_uidx', 'public.projects'::regclass, array['user_id', 'id']),
      ('project_files_tenant_id_uidx', 'public.project_files'::regclass, array['user_id', 'id']),
      ('project_memories_tenant_id_uidx', 'public.project_memories'::regclass, array['user_id', 'id']),
      ('conversations_tenant_id_uidx', 'public.conversations'::regclass, array['user_id', 'id']),
      ('messages_tenant_id_uidx', 'public.messages'::regclass, array['user_id', 'id']),
      ('messages_tenant_conversation_id_uidx', 'public.messages'::regclass, array['user_id', 'conversation_id', 'id']),
      ('code_sessions_tenant_id_uidx', 'public.code_sessions'::regclass, array['user_id', 'id']),
      ('code_messages_tenant_id_uidx', 'public.code_messages'::regclass, array['user_id', 'id']),
      ('conversation_chunks_tenant_id_uidx', 'public.conversation_chunks'::regclass, array['user_id', 'id']),
      ('artifacts_tenant_id_uidx', 'public.artifacts'::regclass, array['user_id', 'id']),
      ('chat_generations_tenant_id_uidx', 'public.chat_generations'::regclass, array['user_id', 'id']),
      ('agent_tasks_tenant_id_uidx', 'public.agent_tasks'::regclass, array['user_id', 'id']),
      ('agent_task_steps_tenant_id_uidx', 'public.agent_task_steps'::regclass, array['user_id', 'id']),
      ('agent_task_steps_tenant_task_id_uidx', 'public.agent_task_steps'::regclass, array['user_id', 'task_id', 'id']),
      ('agent_tool_calls_tenant_id_uidx', 'public.agent_tool_calls'::regclass, array['user_id', 'id']),
      ('agent_workspaces_tenant_id_uidx', 'public.agent_workspaces'::regclass, array['user_id', 'id']),
      ('agent_artifacts_tenant_id_uidx', 'public.agent_artifacts'::regclass, array['user_id', 'id']),
      ('agent_confirmation_gates_tenant_id_uidx', 'public.agent_confirmation_gates'::regclass, array['user_id', 'id']),
      ('jobs_principal_id_uidx', 'public.jobs'::regclass, array['principal_id', 'id']),
      ('ledger_entries_principal_id_uidx', 'public.ledger_entries'::regclass, array['principal_id', 'id'])
  ), installed as (
    select
      expected.*,
      named_relation.oid as named_relation_id,
      installed_index.*,
      expected_keys.attnums as expected_attnums
    from expected
    left join pg_class as named_relation
      on named_relation.relnamespace = 'public'::regnamespace
     and named_relation.relname = expected.index_name
    left join pg_index as installed_index
      on installed_index.indexrelid = named_relation.oid
    cross join lateral (
      select string_agg(attribute.attnum::text, ' ' order by requested.ordinality) as attnums
      from unnest(expected.key_columns) with ordinality as requested(column_name, ordinality)
      join pg_attribute as attribute
        on attribute.attrelid = expected.table_id
       and attribute.attname = requested.column_name
       and attribute.attnum > 0
       and not attribute.attisdropped
    ) as expected_keys
  )
  select string_agg(format('%I', index_name), ', ' order by index_name)
  into unusable_indexes
  from installed
  where named_relation_id is not null
    and (
      indexrelid is null
      or indrelid <> table_id
      or not indisunique
      or not indisvalid
      or not indisready
      or not indislive
      or indnkeyatts <> cardinality(key_columns)
      or indnatts <> cardinality(key_columns)
      or indkey::text <> expected_attnums
      or indpred is not null
      or indexprs is not null
    );

  if unusable_indexes is not null then
    raise exception 'tenant_candidate_index_unusable: %', unusable_indexes
      using errcode = '55000',
            hint = 'Inspect the failed build, then DROP INDEX CONCURRENTLY the unusable index and replay this migration.';
  end if;
end;
$$;

-- Stable tenant-first candidate keys. The UUID primary keys still provide the
-- global identity; these indexes let PostgreSQL prove ownership in each FK.
create unique index concurrently if not exists projects_tenant_id_uidx
  on public.projects(user_id, id);
create unique index concurrently if not exists project_files_tenant_id_uidx
  on public.project_files(user_id, id);
create unique index concurrently if not exists project_memories_tenant_id_uidx
  on public.project_memories(user_id, id);
create unique index concurrently if not exists conversations_tenant_id_uidx
  on public.conversations(user_id, id);
create unique index concurrently if not exists messages_tenant_id_uidx
  on public.messages(user_id, id);
create unique index concurrently if not exists messages_tenant_conversation_id_uidx
  on public.messages(user_id, conversation_id, id);
create unique index concurrently if not exists code_sessions_tenant_id_uidx
  on public.code_sessions(user_id, id);
create unique index concurrently if not exists code_messages_tenant_id_uidx
  on public.code_messages(user_id, id);
create unique index concurrently if not exists conversation_chunks_tenant_id_uidx
  on public.conversation_chunks(user_id, id);
create unique index concurrently if not exists artifacts_tenant_id_uidx
  on public.artifacts(user_id, id);
create unique index concurrently if not exists chat_generations_tenant_id_uidx
  on public.chat_generations(user_id, id);

create unique index concurrently if not exists agent_tasks_tenant_id_uidx
  on public.agent_tasks(user_id, id);
create unique index concurrently if not exists agent_task_steps_tenant_id_uidx
  on public.agent_task_steps(user_id, id);
create unique index concurrently if not exists agent_task_steps_tenant_task_id_uidx
  on public.agent_task_steps(user_id, task_id, id);
create unique index concurrently if not exists agent_tool_calls_tenant_id_uidx
  on public.agent_tool_calls(user_id, id);
create unique index concurrently if not exists agent_workspaces_tenant_id_uidx
  on public.agent_workspaces(user_id, id);
create unique index concurrently if not exists agent_artifacts_tenant_id_uidx
  on public.agent_artifacts(user_id, id);
create unique index concurrently if not exists agent_confirmation_gates_tenant_id_uidx
  on public.agent_confirmation_gates(user_id, id);

create unique index concurrently if not exists jobs_principal_id_uidx
  on public.jobs(principal_id, id);
create unique index concurrently if not exists ledger_entries_principal_id_uidx
  on public.ledger_entries(principal_id, id);

-- PostgreSQL 16 has no ADD CONSTRAINT IF NOT EXISTS. This session-local helper
-- makes each CALL replay-safe and verifies that a pre-existing same-named key is
-- structurally identical instead of silently trusting its name. Under psql
-- autocommit every CALL below is a separate short transaction.
create or replace procedure pg_temp.ensure_tenant_foreign_key(
  input_child_table regclass,
  input_constraint_name text,
  input_child_columns text[],
  input_parent_table regclass,
  input_parent_columns text[],
  input_delete_action text,
  input_delete_columns text[] default null,
  input_deferrable boolean default false,
  input_initially_deferred boolean default false
)
language plpgsql
as $$
declare
  existing_constraint pg_constraint%rowtype;
  child_attnums smallint[];
  parent_attnums smallint[];
  delete_attnums smallint[];
  child_sql text;
  parent_sql text;
  delete_sql text;
begin
  select array_agg(attribute.attnum order by requested.ordinality),
         string_agg(format('%I', requested.column_name), ', ' order by requested.ordinality)
  into child_attnums, child_sql
  from unnest(input_child_columns) with ordinality as requested(column_name, ordinality)
  join pg_attribute as attribute
    on attribute.attrelid = input_child_table
   and attribute.attname = requested.column_name
   and attribute.attnum > 0 and not attribute.attisdropped;

  select array_agg(attribute.attnum order by requested.ordinality),
         string_agg(format('%I', requested.column_name), ', ' order by requested.ordinality)
  into parent_attnums, parent_sql
  from unnest(input_parent_columns) with ordinality as requested(column_name, ordinality)
  join pg_attribute as attribute
    on attribute.attrelid = input_parent_table
   and attribute.attname = requested.column_name
   and attribute.attnum > 0 and not attribute.attisdropped;

  if cardinality(child_attnums) <> cardinality(input_child_columns)
     or cardinality(parent_attnums) <> cardinality(input_parent_columns)
     or cardinality(child_attnums) <> cardinality(parent_attnums) then
    raise exception 'tenant_fk_column_contract_invalid: %', input_constraint_name
      using errcode = '42703';
  end if;

  if input_delete_columns is not null then
    select array_agg(attribute.attnum order by requested.ordinality),
           string_agg(format('%I', requested.column_name), ', ' order by requested.ordinality)
    into delete_attnums, delete_sql
    from unnest(input_delete_columns) with ordinality as requested(column_name, ordinality)
    join pg_attribute as attribute
      on attribute.attrelid = input_child_table
     and attribute.attname = requested.column_name
     and attribute.attnum > 0 and not attribute.attisdropped;
    if cardinality(delete_attnums) <> cardinality(input_delete_columns) then
      raise exception 'tenant_fk_delete_column_contract_invalid: %', input_constraint_name
        using errcode = '42703';
    end if;
  end if;

  if input_delete_action not in ('c', 'n', 'r')
     or (input_delete_action <> 'n' and input_delete_columns is not null)
     or input_initially_deferred and not input_deferrable then
    raise exception 'tenant_fk_action_contract_invalid: %', input_constraint_name
      using errcode = '22023';
  end if;

  select constraint_row.* into existing_constraint
  from pg_constraint as constraint_row
  where constraint_row.conrelid = input_child_table
    and constraint_row.conname = input_constraint_name;

  if found then
    if existing_constraint.contype <> 'f'
       or existing_constraint.confrelid <> input_parent_table
       or existing_constraint.conkey <> child_attnums
       or existing_constraint.confkey <> parent_attnums
       or existing_constraint.confdeltype <> input_delete_action::"char"
       or coalesce(existing_constraint.confdelsetcols, '{}'::smallint[])
          <> coalesce(delete_attnums, '{}'::smallint[])
       or existing_constraint.condeferrable <> input_deferrable
       or existing_constraint.condeferred <> input_initially_deferred then
      raise exception 'tenant_fk_definition_mismatch: %', input_constraint_name
        using errcode = '42P16';
    end if;
    return;
  end if;

  delete_sql := case input_delete_action
    when 'c' then 'cascade'
    when 'r' then 'restrict'
    when 'n' then 'set null' || case
      when delete_sql is null then '' else format(' (%s)', delete_sql)
    end
  end;
  execute format(
    'alter table %s add constraint %I foreign key (%s) references %s (%s) on delete %s%s not valid',
    input_child_table, input_constraint_name, child_sql,
    input_parent_table, parent_sql, delete_sql,
    case when input_deferrable then
      case when input_initially_deferred
        then ' deferrable initially deferred' else ' deferrable'
      end
    else '' end
  );
end;
$$;

-- Product data graph.
call pg_temp.ensure_tenant_foreign_key(
  'public.project_files', 'project_files_tenant_project_fkey',
  array['user_id', 'project_id'], 'public.projects', array['user_id', 'id'], 'c'
);
call pg_temp.ensure_tenant_foreign_key(
  'public.project_memories', 'project_memories_tenant_project_fkey',
  array['user_id', 'project_id'], 'public.projects', array['user_id', 'id'], 'c'
);
call pg_temp.ensure_tenant_foreign_key(
  'public.conversations', 'conversations_tenant_project_fkey',
  array['user_id', 'project_id'], 'public.projects', array['user_id', 'id'], 'n',
  array['project_id']
);
call pg_temp.ensure_tenant_foreign_key(
  'public.messages', 'messages_tenant_conversation_fkey',
  array['user_id', 'conversation_id'], 'public.conversations', array['user_id', 'id'], 'c'
);
call pg_temp.ensure_tenant_foreign_key(
  'public.conversations', 'conversations_tenant_summary_message_fkey',
  array['user_id', 'id', 'summary_until_message_id'], 'public.messages',
  array['user_id', 'conversation_id', 'id'], 'n', array['summary_until_message_id']
);
call pg_temp.ensure_tenant_foreign_key(
  'public.code_messages', 'code_messages_tenant_session_fkey',
  array['user_id', 'session_id'], 'public.code_sessions', array['user_id', 'id'], 'c'
);
call pg_temp.ensure_tenant_foreign_key(
  'public.conversation_chunks', 'conversation_chunks_tenant_conversation_fkey',
  array['user_id', 'conversation_id'], 'public.conversations', array['user_id', 'id'], 'c'
);
call pg_temp.ensure_tenant_foreign_key(
  'public.conversation_chunks', 'conversation_chunks_tenant_project_fkey',
  array['user_id', 'project_id'], 'public.projects', array['user_id', 'id'], 'n',
  array['project_id']
);
call pg_temp.ensure_tenant_foreign_key(
  'public.conversation_chunks', 'conversation_chunks_tenant_message_start_fkey',
  array['user_id', 'conversation_id', 'message_start_id'], 'public.messages',
  array['user_id', 'conversation_id', 'id'], 'n', array['message_start_id']
);
call pg_temp.ensure_tenant_foreign_key(
  'public.conversation_chunks', 'conversation_chunks_tenant_message_end_fkey',
  array['user_id', 'conversation_id', 'message_end_id'], 'public.messages',
  array['user_id', 'conversation_id', 'id'], 'n', array['message_end_id']
);

-- The two-column Artifact message FK protects a message reference even when an
-- old Artifact has no conversation_id. The three-column FK additionally proves
-- that a populated message belongs to the populated Artifact conversation.
call pg_temp.ensure_tenant_foreign_key(
  'public.artifacts', 'artifacts_tenant_conversation_fkey',
  array['user_id', 'conversation_id'], 'public.conversations', array['user_id', 'id'], 'c'
);
call pg_temp.ensure_tenant_foreign_key(
  'public.artifacts', 'artifacts_tenant_message_fkey',
  array['user_id', 'message_id'], 'public.messages', array['user_id', 'id'], 'c'
);
call pg_temp.ensure_tenant_foreign_key(
  'public.artifacts', 'artifacts_conversation_message_fkey',
  array['user_id', 'conversation_id', 'message_id'], 'public.messages',
  array['user_id', 'conversation_id', 'id'], 'c'
);
call pg_temp.ensure_tenant_foreign_key(
  'public.artifacts', 'artifacts_tenant_project_fkey',
  array['user_id', 'project_id'], 'public.projects', array['user_id', 'id'], 'n',
  array['project_id']
);
call pg_temp.ensure_tenant_foreign_key(
  'public.chat_generations', 'chat_generations_tenant_conversation_fkey',
  array['user_id', 'conversation_id'], 'public.conversations', array['user_id', 'id'], 'c'
);
call pg_temp.ensure_tenant_foreign_key(
  'public.chat_generations', 'chat_generations_tenant_assistant_message_fkey',
  array['user_id', 'conversation_id', 'assistant_message_id'], 'public.messages',
  array['user_id', 'conversation_id', 'id'], 'c'
);
call pg_temp.ensure_tenant_foreign_key(
  'public.messages', 'messages_tenant_generation_fkey',
  array['user_id', 'generation_id'], 'public.jobs', array['principal_id', 'id'], 'n',
  array['generation_id']
);

-- Agent data graph. Tool calls bind a step to both the same tenant and task.
call pg_temp.ensure_tenant_foreign_key(
  'public.agent_task_steps', 'agent_task_steps_tenant_task_fkey',
  array['user_id', 'task_id'], 'public.agent_tasks', array['user_id', 'id'], 'c'
);
call pg_temp.ensure_tenant_foreign_key(
  'public.agent_tool_calls', 'agent_tool_calls_tenant_task_fkey',
  array['user_id', 'task_id'], 'public.agent_tasks', array['user_id', 'id'], 'c'
);
call pg_temp.ensure_tenant_foreign_key(
  'public.agent_tool_calls', 'agent_tool_calls_tenant_task_step_fkey',
  array['user_id', 'task_id', 'step_id'], 'public.agent_task_steps',
  array['user_id', 'task_id', 'id'], 'n', array['step_id']
);
call pg_temp.ensure_tenant_foreign_key(
  'public.agent_workspaces', 'agent_workspaces_tenant_task_fkey',
  array['user_id', 'task_id'], 'public.agent_tasks', array['user_id', 'id'], 'c'
);
call pg_temp.ensure_tenant_foreign_key(
  'public.agent_artifacts', 'agent_artifacts_tenant_task_fkey',
  array['user_id', 'task_id'], 'public.agent_tasks', array['user_id', 'id'], 'c'
);
call pg_temp.ensure_tenant_foreign_key(
  'public.agent_confirmation_gates', 'agent_confirmation_gates_tenant_task_fkey',
  array['user_id', 'task_id'], 'public.agent_tasks', array['user_id', 'id'], 'c'
);
call pg_temp.ensure_tenant_foreign_key(
  'public.agent_workspace_heads', 'agent_workspace_heads_tenant_task_fkey',
  array['user_id', 'task_id'], 'public.agent_tasks', array['user_id', 'id'], 'c'
);
call pg_temp.ensure_tenant_foreign_key(
  'public.agent_workspace_heads', 'agent_workspace_heads_tenant_job_fkey',
  array['user_id', 'job_id'], 'public.jobs', array['principal_id', 'id'], 'r'
);

-- Job control-plane data graph.
call pg_temp.ensure_tenant_foreign_key(
  'public.job_events', 'job_events_tenant_job_fkey',
  array['principal_id', 'job_id'], 'public.jobs', array['principal_id', 'id'], 'c'
);
call pg_temp.ensure_tenant_foreign_key(
  'public.job_checkpoints', 'job_checkpoints_tenant_job_fkey',
  array['principal_id', 'job_id'], 'public.jobs', array['principal_id', 'id'], 'c'
);
call pg_temp.ensure_tenant_foreign_key(
  'public.job_tool_effects', 'job_tool_effects_tenant_job_fkey',
  array['principal_id', 'job_id'], 'public.jobs', array['principal_id', 'id'], 'r'
);
call pg_temp.ensure_tenant_foreign_key(
  'public.job_outbox', 'job_outbox_job_principal_fkey',
  array['job_id', 'principal_id'], 'public.jobs', array['id', 'principal_id'], 'c'
);
call pg_temp.ensure_tenant_foreign_key(
  'public.job_assets', 'job_assets_job_principal_fkey',
  array['job_id', 'principal_id'], 'public.jobs', array['id', 'principal_id'], 'r'
);
call pg_temp.ensure_tenant_foreign_key(
  'public.ledger_entries', 'ledger_entries_tenant_job_fkey',
  array['principal_id', 'job_id'], 'public.jobs', array['principal_id', 'id'], 'r'
);
call pg_temp.ensure_tenant_foreign_key(
  'public.ledger_balance_settlements', 'ledger_balance_settlements_tenant_entry_fkey',
  array['principal_id', 'ledger_entry_id'], 'public.ledger_entries',
  array['principal_id', 'id'], 'r'
);

-- Audit rows may intentionally have no principal. When both values are present,
-- this FK proves that the recorded principal owns the referenced Job. The old
-- job-only FK remains below so a principal-less audit row still cannot orphan.
call pg_temp.ensure_tenant_foreign_key(
  'public.audit_log', 'audit_log_tenant_job_fkey',
  array['principal_id', 'job_id'], 'public.jobs', array['principal_id', 'id'], 'r'
);

-- Admission inserts its reservation and Job in either order inside one
-- transaction, so the replacement must retain deferred checking.
call pg_temp.ensure_tenant_foreign_key(
  'public.job_admission_reservations', 'job_admission_reservations_tenant_job_fkey',
  array['principal_id', 'job_id'], 'public.jobs', array['principal_id', 'id'], 'r',
  null, true, true
);

-- A high-risk operation can consume only a confirmation owned by its Job
-- principal. The partial uniqueness on jobs.confirmation_id remains unchanged.
call pg_temp.ensure_tenant_foreign_key(
  'public.jobs', 'jobs_tenant_confirmation_fkey',
  array['principal_id', 'confirmation_id'], 'public.agent_confirmation_gates',
  array['user_id', 'id'], 'r'
);

-- Validation scans existing rows without weakening enforcement for new writes.
alter table public.project_files validate constraint project_files_tenant_project_fkey;
alter table public.project_memories validate constraint project_memories_tenant_project_fkey;
alter table public.conversations validate constraint conversations_tenant_project_fkey;
alter table public.messages validate constraint messages_tenant_conversation_fkey;
alter table public.conversations validate constraint conversations_tenant_summary_message_fkey;
alter table public.code_messages validate constraint code_messages_tenant_session_fkey;
alter table public.conversation_chunks validate constraint conversation_chunks_tenant_conversation_fkey;
alter table public.conversation_chunks validate constraint conversation_chunks_tenant_project_fkey;
alter table public.conversation_chunks validate constraint conversation_chunks_tenant_message_start_fkey;
alter table public.conversation_chunks validate constraint conversation_chunks_tenant_message_end_fkey;
alter table public.artifacts validate constraint artifacts_tenant_conversation_fkey;
alter table public.artifacts validate constraint artifacts_tenant_message_fkey;
alter table public.artifacts validate constraint artifacts_conversation_message_fkey;
alter table public.artifacts validate constraint artifacts_tenant_project_fkey;
alter table public.chat_generations validate constraint chat_generations_tenant_conversation_fkey;
alter table public.chat_generations validate constraint chat_generations_tenant_assistant_message_fkey;
alter table public.messages validate constraint messages_tenant_generation_fkey;

alter table public.agent_task_steps validate constraint agent_task_steps_tenant_task_fkey;
alter table public.agent_tool_calls validate constraint agent_tool_calls_tenant_task_fkey;
alter table public.agent_tool_calls validate constraint agent_tool_calls_tenant_task_step_fkey;
alter table public.agent_workspaces validate constraint agent_workspaces_tenant_task_fkey;
alter table public.agent_artifacts validate constraint agent_artifacts_tenant_task_fkey;
alter table public.agent_confirmation_gates validate constraint agent_confirmation_gates_tenant_task_fkey;
alter table public.agent_workspace_heads validate constraint agent_workspace_heads_tenant_task_fkey;
alter table public.agent_workspace_heads validate constraint agent_workspace_heads_tenant_job_fkey;

alter table public.job_events validate constraint job_events_tenant_job_fkey;
alter table public.job_checkpoints validate constraint job_checkpoints_tenant_job_fkey;
alter table public.job_tool_effects validate constraint job_tool_effects_tenant_job_fkey;
alter table public.job_outbox validate constraint job_outbox_job_principal_fkey;
alter table public.job_assets validate constraint job_assets_job_principal_fkey;
alter table public.ledger_entries validate constraint ledger_entries_tenant_job_fkey;
alter table public.ledger_balance_settlements validate constraint ledger_balance_settlements_tenant_entry_fkey;
alter table public.audit_log validate constraint audit_log_tenant_job_fkey;
alter table public.job_admission_reservations validate constraint job_admission_reservations_tenant_job_fkey;
alter table public.jobs validate constraint jobs_tenant_confirmation_fkey;

-- Expand-only release: keep every legacy FK in parallel with the validated
-- tenant-aware FK. Removing redundant constraints is a separate contract
-- migration after production observation proves all writers use the composite
-- ownership contract. audit_log_job_id_fkey must remain even then because a
-- principal-less audit row still needs job-existence enforcement.

reset statement_timeout;
reset lock_timeout;
