-- Contract phase. Apply only after the lease-aware application release is live
-- and healthy; older instances still depend on direct authenticated upserts.
begin;

-- Generated media is now materialized and uploaded by the service-role runner
-- before terminal CAS. Remove the legacy browser write surface; public reads
-- remain available through the bucket and its select policy.
drop policy if exists "generated_media_upload_own" on storage.objects;
drop policy if exists "generated_media_update_own" on storage.objects;
drop policy if exists "generated_media_delete_own" on storage.objects;

-- Contract phase: stale browser code must receive a failed UPDATE when it tries
-- to overwrite canonical terminal output, otherwise it may cache its stale
-- input after a superficially successful write. Refs/image_summary-only edits
-- remain legal and are merged with the canonical generation payload.
create or replace function public.preserve_terminal_generation_message()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  canonical_id uuid;
  canonical_status text;
  canonical_sequence integer;
  canonical_error text;
  canonical_media jsonb;
begin
  if current_user not in ('authenticated', 'anon') then return new; end if;

  select id, status, sequence, error, media
  into canonical_id, canonical_status, canonical_sequence, canonical_error, canonical_media
  from public.chat_generations
  where assistant_message_id = old.id
    and user_id = old.user_id
    and conversation_id = old.conversation_id;
  if not found then return new; end if;

  if new.id is distinct from old.id
     or new.user_id is distinct from old.user_id
     or new.conversation_id is distinct from old.conversation_id
     or new.role is distinct from old.role
     or new.created_at is distinct from old.created_at then
    raise exception 'generation_message_identity_immutable' using errcode = '55000';
  end if;
  if canonical_status not in ('completed', 'failed', 'cancelled') then return new; end if;

  if new.content is distinct from old.content
     or new.thinking is distinct from old.thinking
     or (
       jsonb_typeof(new.images) = 'object'
       and new.images ? 'generated_media'
       and new.images->'generated_media' is distinct from canonical_media
     )
     or (
       jsonb_typeof(new.images) = 'object'
       and new.images ? 'generation'
       and new.images->'generation' is distinct from jsonb_build_object(
         'id', canonical_id,
         'status', canonical_status,
         'sequence', canonical_sequence,
         'error', canonical_error
       )
     ) then
    raise exception 'terminal_generation_message_immutable' using errcode = '55000';
  end if;

  new.images := (
    case jsonb_typeof(new.images)
      when 'object' then new.images
      when 'array' then jsonb_build_object('refs', new.images, 'image_summary', null)
      else jsonb_build_object('refs', '[]'::jsonb, 'image_summary', null)
    end
  ) || jsonb_build_object(
    'generated_media', canonical_media,
    'generation', jsonb_build_object(
      'id', canonical_id,
      'status', canonical_status,
      'sequence', canonical_sequence,
      'error', canonical_error
    )
  );
  return new;
end;
$$;

revoke insert, update, delete on table public.chat_generations from public, authenticated, anon;
revoke delete on table public.messages from public, authenticated, anon;
revoke delete on table public.conversations from public, authenticated, anon;
revoke update (
  id, user_id, conversation_id, assistant_message_id,
  status, content, thinking, sequence, error,
  lease_owner, lease_expires_at, lease_version, cancel_requested_at,
  media, created_at, updated_at
) on table public.chat_generations from public, authenticated, anon;

-- Close the expand/contract window: a legacy client may have written terminal
-- generation state after 0400's first reconciliation without mirroring messages.
-- Revoke first, then replay every terminal authority before contract readiness
-- can become true.
update public.messages as message
set content = generation.content,
    thinking = nullif(generation.thinking, ''),
    images = (
      case jsonb_typeof(message.images)
        when 'object' then message.images
        when 'array' then jsonb_build_object('refs', message.images, 'image_summary', null)
        else jsonb_build_object('refs', '[]'::jsonb, 'image_summary', null)
      end
    ) || jsonb_build_object(
      'generated_media', generation.media,
      'generation', jsonb_build_object(
        'id', generation.id,
        'status', generation.status,
        'sequence', generation.sequence,
        'error', generation.error
      )
    )
from public.chat_generations as generation
where message.id = generation.assistant_message_id
  and message.user_id = generation.user_id
  and message.conversation_id = generation.conversation_id
  and generation.status in ('completed', 'failed', 'cancelled');

update public.conversations as conversation
set updated_at = greatest(conversation.updated_at, terminal.latest_terminal_at)
from (
  select user_id, conversation_id, max(updated_at) as latest_terminal_at
  from public.chat_generations
  where status in ('completed', 'failed', 'cancelled')
  group by user_id, conversation_id
) as terminal
where terminal.conversation_id = conversation.id
  and terminal.user_id = conversation.user_id;

-- Browser sessions may read the user-facing generation snapshot through RLS,
-- but fencing credentials and cancellation coordination stay server-only.
revoke select on table public.chat_generations from public, authenticated, anon;
grant select (
  id, user_id, conversation_id, assistant_message_id, status,
  content, thinking, sequence, error, media, created_at, updated_at
) on table public.chat_generations to authenticated;

-- Contract readiness includes both the expand-phase primitives and proof that
-- clients can no longer bypass fencing through direct table mutations.
create or replace function public.runtime_healthcheck_v2()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    to_regclass('public.api_rate_limits') is not null
    and to_regprocedure('public.consume_api_rate_limit(text,integer,integer)') is not null
    and has_function_privilege(
      'service_role',
      'public.consume_api_rate_limit(text,integer,integer)',
      'EXECUTE'
    )
    and to_regclass('public.generated_media_cleanup_jobs') is not null
    and to_regprocedure(
      'public.delete_messages_with_media_cleanup(uuid,uuid[],text[])'
    ) is not null
    and to_regprocedure(
      'public.delete_conversation_with_media_cleanup(uuid,uuid,text[])'
    ) is not null
    and has_function_privilege(
      'service_role',
      'public.delete_messages_with_media_cleanup(uuid,uuid[],text[])',
      'EXECUTE'
    )
    and has_function_privilege(
      'service_role',
      'public.delete_conversation_with_media_cleanup(uuid,uuid,text[])',
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'public.delete_messages_with_media_cleanup(uuid,uuid[],text[])',
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'public.delete_conversation_with_media_cleanup(uuid,uuid,text[])',
      'EXECUTE'
    )
    and not has_table_privilege(
      'authenticated', 'public.generated_media_cleanup_jobs', 'SELECT'
    )
    and not has_table_privilege(
      'authenticated', 'public.generated_media_cleanup_jobs', 'INSERT'
    )
    and not has_table_privilege(
      'authenticated', 'public.generated_media_cleanup_jobs', 'UPDATE'
    )
    and not has_table_privilege(
      'authenticated', 'public.generated_media_cleanup_jobs', 'DELETE'
    )
    and to_regclass('storage.buckets') is not null
    and exists (
      select 1
      from storage.buckets
      where id = 'generated-media'
        and public = true
        and coalesce(file_size_limit, 0) >= 10485760
    )
    and exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'chat_generations'
        and column_name = 'cancel_requested_at'
    )
    and exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'chat_generations'
        and column_name = 'media'
        and data_type = 'jsonb'
    )
    and exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'chat_generations'
        and column_name in ('lease_owner', 'lease_expires_at', 'lease_version')
      group by table_schema, table_name
      having count(*) = 3
    )
    and exists (
      select 1
      from pg_catalog.pg_constraint
      where conname = 'chat_generations_assistant_message_fkey'
        and conrelid = 'public.chat_generations'::regclass
        and contype = 'f'
        and convalidated
    )
    and exists (
      select 1
      from pg_catalog.pg_constraint
      where conname = 'chat_generations_assistant_message_key'
        and conrelid = 'public.chat_generations'::regclass
        and contype = 'u'
        and convalidated
    )
    and exists (
      select 1
      from pg_catalog.pg_index
      where indexrelid = to_regclass('public.chat_generations_one_active_conversation_idx')
        and indisunique
        and indisvalid
    )
    and exists (
      select 1
      from pg_catalog.pg_constraint
      where conname = 'chat_generations_media_terminal_check'
        and conrelid = 'public.chat_generations'::regclass
        and contype = 'c'
    )
    and to_regprocedure('public.claim_chat_generation(uuid,uuid,uuid,uuid,uuid,integer)') is not null
    and to_regprocedure('public.renew_chat_generation_lease(uuid,uuid,uuid,bigint,integer)') is not null
    and to_regprocedure('public.write_chat_generation_progress(uuid,uuid,uuid,bigint,text,text,integer)') is not null
    and to_regprocedure('public.finalize_chat_generation(uuid,uuid,uuid,bigint,text,text,text,integer,text,jsonb)') is not null
    and to_regprocedure('public.cancel_chat_generation(uuid,uuid)') is not null
    and to_regprocedure('public.fail_stale_chat_generation(uuid,uuid)') is not null
    and has_function_privilege(
      'service_role',
      'public.claim_chat_generation(uuid,uuid,uuid,uuid,uuid,integer)',
      'EXECUTE'
    )
    and has_function_privilege(
      'service_role',
      'public.renew_chat_generation_lease(uuid,uuid,uuid,bigint,integer)',
      'EXECUTE'
    )
    and has_function_privilege(
      'service_role',
      'public.write_chat_generation_progress(uuid,uuid,uuid,bigint,text,text,integer)',
      'EXECUTE'
    )
    and has_function_privilege(
      'service_role',
      'public.finalize_chat_generation(uuid,uuid,uuid,bigint,text,text,text,integer,text,jsonb)',
      'EXECUTE'
    )
    and has_function_privilege(
      'service_role',
      'public.cancel_chat_generation(uuid,uuid)',
      'EXECUTE'
    )
    and has_function_privilege(
      'service_role',
      'public.fail_stale_chat_generation(uuid,uuid)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'public.claim_chat_generation(uuid,uuid,uuid,uuid,uuid,integer)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'public.renew_chat_generation_lease(uuid,uuid,uuid,bigint,integer)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'public.write_chat_generation_progress(uuid,uuid,uuid,bigint,text,text,integer)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'public.finalize_chat_generation(uuid,uuid,uuid,bigint,text,text,text,integer,text,jsonb)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'public.cancel_chat_generation(uuid,uuid)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'public.fail_stale_chat_generation(uuid,uuid)',
      'EXECUTE'
    )
    and not has_table_privilege('authenticated', 'public.chat_generations', 'INSERT')
    and not has_table_privilege('authenticated', 'public.chat_generations', 'UPDATE')
    and not has_table_privilege('authenticated', 'public.chat_generations', 'DELETE')
    and not has_table_privilege('authenticated', 'public.messages', 'DELETE')
    and not has_table_privilege('authenticated', 'public.conversations', 'DELETE')
    and not has_table_privilege('anon', 'public.chat_generations', 'INSERT')
    and not has_table_privilege('anon', 'public.chat_generations', 'UPDATE')
    and not has_table_privilege('anon', 'public.chat_generations', 'DELETE')
    and not exists (
      select 1
      from unnest(array[
        'id', 'user_id', 'conversation_id', 'assistant_message_id',
        'status', 'content', 'thinking', 'sequence', 'error',
        'lease_owner', 'lease_expires_at', 'lease_version',
        'cancel_requested_at', 'media', 'created_at', 'updated_at'
      ]) as writable_column(column_name)
      where has_column_privilege(
        'authenticated', 'public.chat_generations', writable_column.column_name, 'UPDATE'
      )
         or has_column_privilege(
        'anon', 'public.chat_generations', writable_column.column_name, 'UPDATE'
      )
    )
    and not has_any_column_privilege(
      'authenticated', 'public.chat_generations', 'UPDATE'
    )
    and not has_any_column_privilege(
      'anon', 'public.chat_generations', 'UPDATE'
    )
    and not has_column_privilege(
      'authenticated', 'public.chat_generations', 'lease_owner', 'SELECT'
    )
    and not has_column_privilege(
      'authenticated', 'public.chat_generations', 'lease_expires_at', 'SELECT'
    )
    and not has_column_privilege(
      'authenticated', 'public.chat_generations', 'lease_version', 'SELECT'
    )
    and not has_column_privilege(
      'anon', 'public.chat_generations', 'lease_owner', 'SELECT'
    )
    and not has_column_privilege(
      'anon', 'public.chat_generations', 'lease_version', 'SELECT'
    )
    and not exists (
      select 1
      from pg_catalog.pg_policies
      where schemaname = 'storage'
        and tablename = 'objects'
        and policyname in (
          'generated_media_upload_own',
          'generated_media_update_own',
          'generated_media_delete_own'
        )
    )
    and exists (
      select 1
      from pg_catalog.pg_trigger
      where tgname = 'preserve_chat_generation_terminal_status'
        and tgrelid = 'public.chat_generations'::regclass
        and not tgisinternal
        and tgenabled <> 'D'
    )
    and exists (
      select 1
      from pg_catalog.pg_trigger
      where tgname = 'preserve_terminal_generation_message'
        and tgrelid = 'public.messages'::regclass
        and not tgisinternal
        and tgenabled <> 'D'
    )
    and exists (
      select 1
      from pg_catalog.pg_trigger
      where tgname = 'reject_active_generation_message_delete'
        and tgrelid = 'public.messages'::regclass
        and not tgisinternal
        and tgenabled <> 'D'
    );
$$;

revoke all on function public.runtime_healthcheck_v2() from public, anon, authenticated;
grant execute on function public.runtime_healthcheck_v2() to service_role;

commit;
