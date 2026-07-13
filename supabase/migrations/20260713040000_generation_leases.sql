-- Follow-up generation lease migration. The 030000 migration was already applied
-- in production and remains immutable; this migration is applied as one transaction.
begin;

-- Atomic claim/lease, fenced progress and terminal CAS for chat generations.

alter table public.chat_generations
  add column if not exists cancel_requested_at timestamptz,
  add column if not exists lease_owner uuid,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists lease_version bigint not null default 0,
  add column if not exists media jsonb not null default '[]'::jsonb;

alter table public.chat_generations
  drop constraint if exists chat_generations_lease_version_check;
alter table public.chat_generations
  add constraint chat_generations_lease_version_check check (lease_version >= 0);

alter table public.chat_generations
  drop constraint if exists chat_generations_media_terminal_check;
alter table public.chat_generations
  add constraint chat_generations_media_terminal_check check (
    jsonb_typeof(media) = 'array'
    and jsonb_array_length(media) <= 4
    and (status = 'completed' or media = '[]'::jsonb)
  );

create index if not exists chat_generations_expired_lease_idx
  on public.chat_generations(lease_expires_at)
  where status in ('queued', 'running');

-- Every newly claimed generation must keep its canonical assistant placeholder
-- alive for the lifetime of the generation row. NOT VALID keeps deployment safe
-- if a legacy best-effort write created an orphan before this contract existed,
-- while PostgreSQL still enforces the constraint for every new row.
alter table public.chat_generations
  drop constraint if exists chat_generations_assistant_message_fkey;
alter table public.chat_generations
  add constraint chat_generations_assistant_message_fkey
  foreign key (assistant_message_id) references public.messages(id) on delete cascade
  not valid;

-- Reconcile the legacy two-write implementation before making one assistant
-- placeholder the unique authority for a generation. Invalid/orphan identities
-- cannot be resumed safely and are removed. When legacy duplicates exist, keep
-- the most advanced terminal snapshot (or newest active snapshot) and fence the
-- rest by deleting their rows before the unique constraint is installed.
delete from public.chat_generations as generation
where not exists (
  select 1
  from public.messages as message
  where message.id = generation.assistant_message_id
    and message.user_id = generation.user_id
    and message.conversation_id = generation.conversation_id
    and message.role = 'assistant'
);

with ranked_generations as (
  select id,
    row_number() over (
      partition by assistant_message_id
      order by
        case when status in ('completed', 'failed', 'cancelled') then 0 else 1 end,
        sequence desc,
        updated_at desc,
        created_at desc,
        id desc
    ) as authority_rank
  from public.chat_generations
)
delete from public.chat_generations as generation
using ranked_generations as ranked
where generation.id = ranked.id and ranked.authority_rank > 1;

with ranked_active_generations as (
  select id,
    row_number() over (
      partition by user_id, conversation_id
      order by sequence desc, updated_at desc, created_at desc, id desc
    ) as active_rank
  from public.chat_generations
  where status in ('queued', 'running')
), removed_active_generations as (
  delete from public.chat_generations as generation
  using ranked_active_generations as ranked
  where generation.id = ranked.id and ranked.active_rank > 1
  returning generation.assistant_message_id
)
delete from public.messages as message
using removed_active_generations as removed
where message.id = removed.assistant_message_id;

create unique index if not exists chat_generations_one_active_conversation_idx
  on public.chat_generations(user_id, conversation_id)
  where status in ('queued', 'running');

-- Recover only already-durable legacy Storage URLs. Inline data and provider
-- URLs are intentionally not promoted into the canonical generation snapshot.
update public.chat_generations as generation
set media = message.images->'generated_media'
from public.messages as message
where generation.assistant_message_id = message.id
  and generation.user_id = message.user_id
  and generation.conversation_id = message.conversation_id
  and generation.status = 'completed'
  and generation.media = '[]'::jsonb
  and case
    when jsonb_typeof(message.images->'generated_media') = 'array' then
      jsonb_array_length(message.images->'generated_media') <= 4
      and (
        select count(*) = count(distinct (item->>'type') || ':' || (item->>'url'))
        from jsonb_array_elements(message.images->'generated_media') as media_identity(item)
      )
      and not exists (
        select 1
        from jsonb_array_elements(message.images->'generated_media') as media_item(item)
        where jsonb_typeof(item) <> 'object'
          or item->>'type' not in ('image', 'video')
          or jsonb_typeof(item->'url') <> 'string'
          or length(item->>'url') > 8192
          or item->>'url' !~*
            '^https://[a-z0-9-]+[.]supabase[.]co/storage/v1/object/public/generated-media/[0-9a-f-]+/[0-9a-f-]+/[A-Za-z0-9_./-]+$'
          or item->>'url' not like
            'https://%/storage/v1/object/public/generated-media/'
            || generation.user_id::text || '/' || generation.conversation_id::text || '/%'
          or not exists (
            select 1
            from storage.objects as stored_object
            where stored_object.bucket_id = 'generated-media'
              and stored_object.name = split_part(
                item->>'url',
                '/storage/v1/object/public/generated-media/',
                2
              )
          )
          or (
            item->>'type' = 'image'
            and coalesce(item->>'mimeType', '') !~ '^image/(png|jpeg|jpg|webp|gif)$'
          )
          or (
            item->>'type' = 'video'
            and coalesce(item->>'mimeType', '') !~ '^video/(mp4|webm|quicktime)$'
          )
          or (item ? 'alt' and (
            jsonb_typeof(item->'alt') <> 'string' or length(item->>'alt') > 500
          ))
      )
    else false
  end;

-- Terminal generation state is canonical. Backfill the assistant row in one
-- statement, preserving legitimate refs/image_summary while repairing content,
-- thinking, media, and the namespaced terminal metadata used by fresh devices.
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

alter table public.chat_generations
  validate constraint chat_generations_assistant_message_fkey;

do $$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conname = 'chat_generations_assistant_message_key'
      and conrelid = 'public.chat_generations'::regclass
  ) then
    alter table public.chat_generations
      add constraint chat_generations_assistant_message_key unique (assistant_message_id);
  end if;
end;
$$;

-- Expand-phase compatibility keeps legacy status/progress writes, but never
-- exposes identity, fencing, or canonical media columns to browser UPDATEs.
-- Strict ownership checks also prevent a user who guesses another assistant id
-- from occupying the global assistant uniqueness key.
drop policy if exists "chat_generations_insert" on public.chat_generations;
create policy "chat_generations_insert"
  on public.chat_generations for insert to authenticated
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.conversations
      where id = conversation_id and user_id = auth.uid()
    )
    and exists (
      select 1 from public.messages
      where id = assistant_message_id
        and user_id = auth.uid()
        and conversation_id = chat_generations.conversation_id
        and role = 'assistant'
    )
  );

drop policy if exists "chat_generations_update" on public.chat_generations;
create policy "chat_generations_update"
  on public.chat_generations for update to authenticated
  using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.conversations
      where id = conversation_id and user_id = auth.uid()
    )
    and exists (
      select 1 from public.messages
      where id = assistant_message_id
        and user_id = auth.uid()
        and conversation_id = chat_generations.conversation_id
        and role = 'assistant'
    )
  );

revoke update on table public.chat_generations from public, anon, authenticated;
grant update (
  status, content, thinking, sequence, error, cancel_requested_at, updated_at
) on table public.chat_generations to authenticated;

-- Remove any earlier authenticated overloads before installing the privileged
-- service-only API. This also makes the migration safe to retry in environments
-- that briefly tested a pre-release version of the lease contract.
drop function if exists public.claim_chat_generation(uuid, uuid, uuid, uuid, integer);
drop function if exists public.renew_chat_generation_lease(uuid, uuid, bigint, integer);
drop function if exists public.write_chat_generation_progress(uuid, uuid, bigint, text, text, integer);
drop function if exists public.finalize_chat_generation(uuid, uuid, bigint, text, text, text, integer, text);
drop function if exists public.finalize_chat_generation(uuid, uuid, uuid, bigint, text, text, text, integer, text);
drop function if exists public.cancel_chat_generation(uuid);
drop function if exists public.fail_stale_chat_generation(uuid);

-- Claim is the single linearization point before a model runner starts. New rows
-- are inserted for the user identity already verified by the application server.
-- Only service_role may execute this API. An existing live lease
-- rejects a duplicate runner. Because chat tools do not all have resumable,
-- idempotent checkpoints, an expired lease is atomically failed as stale rather
-- than rerun from the beginning. Parent ownership and task identity are checked in
-- the security-definer function rather than being trusted from RPC arguments.
create or replace function public.claim_chat_generation(
  input_generation_id uuid,
  input_user_id uuid,
  input_conversation_id uuid,
  input_assistant_message_id uuid,
  input_runner_id uuid,
  lease_seconds integer default 45
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  lease_duration integer := greatest(15, least(coalesce(lease_seconds, 45), 300));
  lease_until timestamptz := clock_timestamp() + make_interval(secs => lease_duration);
  current_generation public.chat_generations%rowtype;
  affected integer;
begin
  if input_user_id is null then
    return jsonb_build_object(
      'acquired', false, 'reason', 'not_found', 'status', null, 'media', '[]'::jsonb
    );
  end if;
  if input_generation_id is null or input_conversation_id is null
     or input_assistant_message_id is null or input_runner_id is null then
    raise exception 'invalid_generation_claim' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.conversations
    where id = input_conversation_id and user_id = input_user_id
  ) then
    return jsonb_build_object(
      'acquired', false, 'reason', 'invalid_parent', 'status', null, 'media', '[]'::jsonb
    );
  end if;

  -- The model may not start unless the exact canonical placeholder already
  -- exists. The key-share lock closes the delete race until the generation row
  -- (and its FK) is inserted. Missing rows and every identity/role mismatch use
  -- the same non-enumerating result.
  perform 1
  from public.messages
  where id = input_assistant_message_id
    and user_id = input_user_id
    and conversation_id = input_conversation_id
    and role = 'assistant'
  for key share;
  if not found then
    return jsonb_build_object(
      'acquired', false,
      'reason', 'identity_mismatch',
      'status', null,
      'media', '[]'::jsonb
    );
  end if;

  insert into public.chat_generations(
    id, user_id, conversation_id, assistant_message_id, status,
    content, thinking, sequence, media, lease_owner, lease_expires_at,
    lease_version, updated_at
  ) values (
    input_generation_id, input_user_id, input_conversation_id,
    input_assistant_message_id, 'running', '', '', 0, '[]'::jsonb,
    input_runner_id, lease_until, 1, clock_timestamp()
  )
  on conflict do nothing;
  get diagnostics affected = row_count;

  if affected = 1 then
    return jsonb_build_object(
      'acquired', true,
      'status', 'running',
      'leaseVersion', 1,
      'leaseExpiresAt', lease_until,
      'media', '[]'::jsonb
    );
  end if;

  select * into current_generation
  from public.chat_generations
  where id = input_generation_id
  for update;

  if not found then
    select * into current_generation
    from public.chat_generations
    where assistant_message_id = input_assistant_message_id
    for update;
    if found
       and current_generation.user_id = input_user_id
       and current_generation.conversation_id = input_conversation_id then
      return jsonb_build_object(
        'acquired', false,
        'reason', 'assistant_conflict',
        'status', current_generation.status,
        'media', current_generation.media
      );
    end if;
    select * into current_generation
    from public.chat_generations
    where user_id = input_user_id
      and conversation_id = input_conversation_id
      and status in ('queued', 'running')
    for update;
    if found then
      if current_generation.lease_expires_at is null
         or current_generation.lease_expires_at <= clock_timestamp() then
        update public.chat_generations
        set status = 'failed',
            error = 'stale_generation_lease_expired',
            sequence = sequence + 1,
            media = '[]'::jsonb,
            lease_owner = null,
            lease_expires_at = null,
            updated_at = clock_timestamp()
        where id = current_generation.id
        returning * into current_generation;
        update public.messages
        set content = current_generation.content,
            thinking = nullif(current_generation.thinking, ''),
            images = (
              case jsonb_typeof(images)
                when 'object' then images
                when 'array' then jsonb_build_object('refs', images, 'image_summary', null)
                else jsonb_build_object('refs', '[]'::jsonb, 'image_summary', null)
              end
            ) || jsonb_build_object(
              'generated_media', current_generation.media,
              'generation', jsonb_build_object(
                'id', current_generation.id,
                'status', current_generation.status,
                'sequence', current_generation.sequence,
                'error', current_generation.error
              )
            )
        where id = current_generation.assistant_message_id
          and user_id = input_user_id
          and conversation_id = current_generation.conversation_id;
        update public.conversations
        set updated_at = clock_timestamp()
        where id = current_generation.conversation_id and user_id = input_user_id;
        return jsonb_build_object(
          'acquired', false,
          'reason', 'stale',
          'status', current_generation.status,
          'media', current_generation.media
        );
      end if;
      return jsonb_build_object(
        'acquired', false,
        'reason', 'conversation_active',
        'status', current_generation.status,
        'media', current_generation.media
      );
    end if;
    return jsonb_build_object(
      'acquired', false, 'reason', 'not_found', 'status', null, 'media', '[]'::jsonb
    );
  end if;
  if current_generation.user_id <> input_user_id then
    return jsonb_build_object(
      'acquired', false, 'reason', 'not_found', 'status', null, 'media', '[]'::jsonb
    );
  end if;
  if current_generation.conversation_id <> input_conversation_id
     or current_generation.assistant_message_id <> input_assistant_message_id then
    return jsonb_build_object(
      'acquired', false,
      'reason', 'identity_mismatch',
      'status', current_generation.status,
      'media', current_generation.media
    );
  end if;
  if current_generation.status in ('completed', 'failed', 'cancelled') then
    return jsonb_build_object(
      'acquired', false,
      'reason', 'terminal',
      'status', current_generation.status,
      'media', current_generation.media
    );
  end if;
  if current_generation.lease_owner is not null
     and current_generation.lease_expires_at > clock_timestamp() then
    return jsonb_build_object(
      'acquired', false,
      'reason', 'active',
      'status', current_generation.status,
      'media', current_generation.media
    );
  end if;

  update public.chat_generations
  set status = 'failed',
      error = 'stale_generation_lease_expired',
      sequence = sequence + 1,
      media = '[]'::jsonb,
      lease_owner = null,
      lease_expires_at = null,
      updated_at = clock_timestamp()
  where id = input_generation_id
  returning * into current_generation;

  update public.messages
  set content = current_generation.content,
      thinking = nullif(current_generation.thinking, ''),
      images = (
        case jsonb_typeof(images)
          when 'object' then images
          when 'array' then jsonb_build_object('refs', images, 'image_summary', null)
          else jsonb_build_object('refs', '[]'::jsonb, 'image_summary', null)
        end
      ) || jsonb_build_object(
        'generated_media', current_generation.media,
        'generation', jsonb_build_object(
          'id', current_generation.id,
          'status', current_generation.status,
          'sequence', current_generation.sequence,
          'error', current_generation.error
        )
      )
  where id = current_generation.assistant_message_id
    and user_id = input_user_id
    and conversation_id = current_generation.conversation_id;

  update public.conversations
  set updated_at = clock_timestamp()
  where id = current_generation.conversation_id and user_id = input_user_id;

  return jsonb_build_object(
    'acquired', false,
    'reason', 'stale',
    'status', current_generation.status,
    'media', current_generation.media
  );
end;
$$;

-- Renewal and stale detection serialize on the same generation row. If renewal
-- wins first the task remains live; if a later claim observes expiry first it
-- marks the task failed and the old fencing token cannot write or finalize.
create or replace function public.renew_chat_generation_lease(
  input_generation_id uuid,
  input_user_id uuid,
  input_runner_id uuid,
  input_lease_version bigint,
  lease_seconds integer default 45
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare affected integer;
begin
  if input_user_id is null or input_generation_id is null or input_runner_id is null
     or input_lease_version is null or input_lease_version < 1 then
    return false;
  end if;
  update public.chat_generations
  set lease_expires_at = clock_timestamp() + make_interval(
        secs => greatest(15, least(coalesce(lease_seconds, 45), 300))
      ),
      updated_at = clock_timestamp()
  where id = input_generation_id
    and user_id = input_user_id
    and status = 'running'
    and cancel_requested_at is null
    and lease_owner = input_runner_id
    and lease_version = input_lease_version
    and lease_expires_at > clock_timestamp();
  get diagnostics affected = row_count;
  return affected = 1;
end;
$$;

create or replace function public.write_chat_generation_progress(
  input_generation_id uuid,
  input_user_id uuid,
  input_runner_id uuid,
  input_lease_version bigint,
  input_content text,
  input_thinking text,
  input_sequence integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_generation public.chat_generations%rowtype;
begin
  if input_user_id is null or input_sequence is null or input_sequence < 0 then
    return jsonb_build_object('accepted', false, 'status', null, 'media', '[]'::jsonb);
  end if;
  update public.chat_generations
  set content = coalesce(input_content, ''),
      thinking = coalesce(input_thinking, ''),
      sequence = input_sequence,
      updated_at = clock_timestamp()
  where id = input_generation_id
    and user_id = input_user_id
    and status = 'running'
    and cancel_requested_at is null
    and lease_owner = input_runner_id
    and lease_version = input_lease_version
    and lease_expires_at > clock_timestamp()
    and input_sequence >= sequence
  returning * into current_generation;

  if found then
    update public.messages
    set content = current_generation.content,
        thinking = nullif(current_generation.thinking, '')
    where id = current_generation.assistant_message_id
      and user_id = input_user_id
      and conversation_id = current_generation.conversation_id;
    return jsonb_build_object(
      'accepted', true,
      'status', current_generation.status,
      'content', current_generation.content,
      'thinking', current_generation.thinking,
      'sequence', current_generation.sequence,
      'media', current_generation.media
    );
  end if;

  select * into current_generation
  from public.chat_generations
  where id = input_generation_id and user_id = input_user_id;
  return jsonb_build_object(
    'accepted', false,
    'status', case when found then current_generation.status else null end,
    'error', case when found then current_generation.error else null end,
    'content', case when found then current_generation.content else null end,
    'thinking', case when found then current_generation.thinking else null end,
    'sequence', case when found then current_generation.sequence else null end,
    'media', case when found then current_generation.media else '[]'::jsonb end
  );
end;
$$;

-- Terminal CAS: only the current unexpired fencing token may finish a running
-- task. A concurrent cancellation and completion serialize on this update; the
-- winner is returned to the caller and all local state must mirror that status.
create or replace function public.finalize_chat_generation(
  input_generation_id uuid,
  input_user_id uuid,
  input_runner_id uuid,
  input_lease_version bigint,
  input_status text,
  input_content text,
  input_thinking text,
  input_sequence integer,
  input_error text default null,
  input_media jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_generation public.chat_generations%rowtype;
  terminal_media jsonb;
begin
  if input_user_id is null or input_status not in ('completed', 'failed', 'cancelled')
     or input_sequence is null or input_sequence < 0 then
    return jsonb_build_object('accepted', false, 'status', null, 'media', '[]'::jsonb);
  end if;
  if input_status = 'completed' then
    if input_media is null or jsonb_typeof(input_media) <> 'array'
       or jsonb_array_length(input_media) > 4 then
      raise exception 'invalid_generation_media' using errcode = '22023';
    end if;
    if (
      select count(*) <> count(distinct (item->>'type') || ':' || (item->>'url'))
      from jsonb_array_elements(input_media) as media_identity(item)
    ) then
      raise exception 'invalid_generation_media' using errcode = '22023';
    end if;
    if exists (
      select 1
      from jsonb_array_elements(input_media) as media_item(item)
      where jsonb_typeof(item) <> 'object'
        or item->>'type' not in ('image', 'video')
        or coalesce(length(item->>'url'), 0) < 9
        or length(item->>'url') > 8192
        or item->>'url' !~ '^https://[^[:space:]]+$'
        or (
          item->>'type' = 'image'
          and coalesce(item->>'mimeType', '') !~ '^image/(png|jpeg|jpg|webp|gif)$'
        )
        or (
          item->>'type' = 'video'
          and coalesce(item->>'mimeType', '') !~ '^video/(mp4|webm|quicktime)$'
        )
        or (item ? 'alt' and (
          jsonb_typeof(item->'alt') <> 'string' or length(item->>'alt') > 500
        ))
    ) then
      raise exception 'invalid_generation_media' using errcode = '22023';
    end if;
    terminal_media := input_media;
  else
    terminal_media := '[]'::jsonb;
  end if;
  update public.chat_generations
  set status = input_status,
      content = coalesce(input_content, ''),
      thinking = coalesce(input_thinking, ''),
      sequence = input_sequence,
      media = terminal_media,
      error = case when input_status = 'failed' then input_error else null end,
      cancel_requested_at = case
        when input_status = 'cancelled' then coalesce(cancel_requested_at, clock_timestamp())
        else cancel_requested_at
      end,
      lease_owner = null,
      lease_expires_at = null,
      updated_at = clock_timestamp()
  where id = input_generation_id
    and user_id = input_user_id
    and status = 'running'
    and (input_status = 'cancelled' or cancel_requested_at is null)
    and lease_owner = input_runner_id
    and lease_version = input_lease_version
    and lease_expires_at > clock_timestamp()
    and input_sequence >= sequence
  returning * into current_generation;

  if found then
    update public.messages
    set content = current_generation.content,
        thinking = nullif(current_generation.thinking, ''),
        images = (
          case jsonb_typeof(images)
            when 'object' then images
            when 'array' then jsonb_build_object('refs', images, 'image_summary', null)
            else jsonb_build_object('refs', '[]'::jsonb, 'image_summary', null)
          end
        ) || jsonb_build_object(
          'generated_media', current_generation.media,
          'generation', jsonb_build_object(
            'id', current_generation.id,
            'status', current_generation.status,
            'sequence', current_generation.sequence,
            'error', current_generation.error
          )
        )
    where id = current_generation.assistant_message_id
      and user_id = input_user_id
      and conversation_id = current_generation.conversation_id;
    update public.conversations
    set updated_at = clock_timestamp()
    where id = current_generation.conversation_id and user_id = input_user_id;
    return jsonb_build_object(
      'accepted', true,
      'status', current_generation.status,
      'error', current_generation.error,
      'content', current_generation.content,
      'thinking', current_generation.thinking,
      'sequence', current_generation.sequence,
      'media', current_generation.media
    );
  end if;

  select * into current_generation
  from public.chat_generations
  where id = input_generation_id and user_id = input_user_id;
  return jsonb_build_object(
    'accepted', false,
    'status', case when found then current_generation.status else null end,
    'error', case when found then current_generation.error else null end,
    'content', case when found then current_generation.content else null end,
    'thinking', case when found then current_generation.thinking else null end,
    'sequence', case when found then current_generation.sequence else null end,
    'media', case when found then current_generation.media else '[]'::jsonb end
  );
end;
$$;

create or replace function public.cancel_chat_generation(
  input_generation_id uuid,
  input_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_generation public.chat_generations%rowtype;
begin
  if input_user_id is null then
    return jsonb_build_object('accepted', false, 'status', null, 'media', '[]'::jsonb);
  end if;
  update public.chat_generations
  set status = 'cancelled',
      cancel_requested_at = coalesce(cancel_requested_at, clock_timestamp()),
      sequence = sequence + 1,
      media = '[]'::jsonb,
      lease_owner = null,
      lease_expires_at = null,
      updated_at = clock_timestamp()
  where id = input_generation_id
    and user_id = input_user_id
    and status in ('queued', 'running')
  returning * into current_generation;

  if found then
    update public.messages
    set content = current_generation.content,
        thinking = nullif(current_generation.thinking, ''),
        images = (
          case jsonb_typeof(images)
            when 'object' then images
            when 'array' then jsonb_build_object('refs', images, 'image_summary', null)
            else jsonb_build_object('refs', '[]'::jsonb, 'image_summary', null)
          end
        ) || jsonb_build_object(
          'generated_media', current_generation.media,
          'generation', jsonb_build_object(
            'id', current_generation.id,
            'status', current_generation.status,
            'sequence', current_generation.sequence,
            'error', current_generation.error
          )
        )
    where id = current_generation.assistant_message_id
      and user_id = input_user_id
      and conversation_id = current_generation.conversation_id;
    update public.conversations
    set updated_at = clock_timestamp()
    where id = current_generation.conversation_id and user_id = input_user_id;
    return jsonb_build_object(
      'accepted', true,
      'status', 'cancelled',
      'content', current_generation.content,
      'thinking', current_generation.thinking,
      'sequence', current_generation.sequence,
      'media', current_generation.media
    );
  end if;

  select * into current_generation
  from public.chat_generations
  where id = input_generation_id and user_id = input_user_id;
  return jsonb_build_object(
    'accepted', false,
    'status', case when found then current_generation.status else null end,
    'error', case when found then current_generation.error else null end,
    'content', case when found then current_generation.content else null end,
    'thinking', case when found then current_generation.thinking else null end,
    'sequence', case when found then current_generation.sequence else null end,
    'media', case when found then current_generation.media else '[]'::jsonb end
  );
end;
$$;

-- Resume/bootstrap calls this dedicated CAS for orphan cleanup. It never creates
-- or claims work: only a row whose lease is expired according to the database
-- clock can transition from running/queued to the explicit stale failure.
create or replace function public.fail_stale_chat_generation(
  input_generation_id uuid,
  input_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_generation public.chat_generations%rowtype;
begin
  if input_user_id is null then
    return jsonb_build_object('accepted', false, 'status', null, 'media', '[]'::jsonb);
  end if;
  update public.chat_generations
  set status = 'failed',
      error = 'stale_generation_lease_expired',
      sequence = sequence + 1,
      media = '[]'::jsonb,
      lease_owner = null,
      lease_expires_at = null,
      updated_at = clock_timestamp()
  where id = input_generation_id
    and user_id = input_user_id
    and status in ('queued', 'running')
    and (lease_expires_at is null or lease_expires_at <= clock_timestamp())
  returning * into current_generation;

  if found then
    update public.messages
    set content = current_generation.content,
        thinking = nullif(current_generation.thinking, ''),
        images = (
          case jsonb_typeof(images)
            when 'object' then images
            when 'array' then jsonb_build_object('refs', images, 'image_summary', null)
            else jsonb_build_object('refs', '[]'::jsonb, 'image_summary', null)
          end
        ) || jsonb_build_object(
          'generated_media', current_generation.media,
          'generation', jsonb_build_object(
            'id', current_generation.id,
            'status', current_generation.status,
            'sequence', current_generation.sequence,
            'error', current_generation.error
          )
        )
    where id = current_generation.assistant_message_id
      and user_id = input_user_id
      and conversation_id = current_generation.conversation_id;
    update public.conversations
    set updated_at = clock_timestamp()
    where id = current_generation.conversation_id and user_id = input_user_id;
    return jsonb_build_object(
      'accepted', true,
      'status', current_generation.status,
      'error', current_generation.error,
      'content', current_generation.content,
      'thinking', current_generation.thinking,
      'sequence', current_generation.sequence,
      'media', current_generation.media
    );
  end if;

  select * into current_generation
  from public.chat_generations
  where id = input_generation_id and user_id = input_user_id;
  return jsonb_build_object(
    'accepted', false,
    'status', case when found then current_generation.status else null end,
    'error', case when found then current_generation.error else null end,
    'content', case when found then current_generation.content else null end,
    'thinking', case when found then current_generation.thinking else null end,
    'sequence', case when found then current_generation.sequence else null end,
    'media', case when found then current_generation.media else '[]'::jsonb end
  );
end;
$$;

revoke all on function public.claim_chat_generation(uuid, uuid, uuid, uuid, uuid, integer)
  from public, anon, authenticated;
revoke all on function public.renew_chat_generation_lease(uuid, uuid, uuid, bigint, integer)
  from public, anon, authenticated;
revoke all on function public.write_chat_generation_progress(uuid, uuid, uuid, bigint, text, text, integer)
  from public, anon, authenticated;
revoke all on function public.finalize_chat_generation(uuid, uuid, uuid, bigint, text, text, text, integer, text, jsonb)
  from public, anon, authenticated;
revoke all on function public.cancel_chat_generation(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.fail_stale_chat_generation(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.claim_chat_generation(uuid, uuid, uuid, uuid, uuid, integer)
  to service_role;
grant execute on function public.renew_chat_generation_lease(uuid, uuid, uuid, bigint, integer)
  to service_role;
grant execute on function public.write_chat_generation_progress(uuid, uuid, uuid, bigint, text, text, integer)
  to service_role;
grant execute on function public.finalize_chat_generation(uuid, uuid, uuid, bigint, text, text, text, integer, text, jsonb)
  to service_role;
grant execute on function public.cancel_chat_generation(uuid, uuid)
  to service_role;
grant execute on function public.fail_stale_chat_generation(uuid, uuid)
  to service_role;

-- Expand phase: keep existing authenticated table grants until the new app is
-- fully deployed. The follow-up 050000 contract migration revokes direct writes.
grant select on table public.chat_generations to authenticated;

-- Once a terminal state wins, delayed snapshots from another instance cannot
-- accidentally resurrect the task. Cancellation and completion serialize through
-- their conditional updates; this trigger is a final defense for privileged writes.
create or replace function public.preserve_chat_generation_terminal_status()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if old.status in ('completed', 'failed', 'cancelled') then
    return old;
  end if;
  if new.sequence < old.sequence then
    new.sequence := old.sequence;
    new.content := old.content;
    new.thinking := old.thinking;
    new.media := old.media;
    new.error := coalesce(new.error, old.error);
  end if;
  if new.status = 'cancelled' and new.cancel_requested_at is null then
    new.cancel_requested_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists preserve_chat_generation_terminal_status on public.chat_generations;
create trigger preserve_chat_generation_terminal_status
before update on public.chat_generations
for each row execute function public.preserve_chat_generation_terminal_status();

-- Old browser clients may still issue an unversioned messages UPDATE after the
-- terminal CAS commits. Reject canonical-field or identity changes so callers
-- cannot cache a superficially successful stale write; refs/image_summary-only
-- edits remain legal. Security-definer generation RPCs execute as their owner
-- and therefore remain able to install the canonical snapshot itself.
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
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;

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
  if canonical_status not in ('completed', 'failed', 'cancelled') then
    return new;
  end if;

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

drop trigger if exists preserve_terminal_generation_message on public.messages;
create trigger preserve_terminal_generation_message
before update on public.messages
for each row execute function public.preserve_terminal_generation_message();

-- Deleting a running assistant placeholder would otherwise cascade-delete its
-- generation row while the external runner keeps working. Reject active deletes;
-- once cancellation/terminal CAS is confirmed, normal message deletion may
-- proceed and ON DELETE CASCADE cleans the terminal generation record.
create or replace function public.reject_active_generation_message_delete()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if exists (
    select 1
    from public.chat_generations
    where assistant_message_id = old.id
      and user_id = old.user_id
      and conversation_id = old.conversation_id
      and status in ('queued', 'running')
  ) then
    raise exception 'active_generation_message_delete'
      using errcode = '55000';
  end if;
  return old;
end;
$$;

revoke all on function public.reject_active_generation_message_delete()
  from public, anon, authenticated;
drop trigger if exists reject_active_generation_message_delete on public.messages;
create trigger reject_active_generation_message_delete
before delete on public.messages
for each row execute function public.reject_active_generation_message_delete();

-- Storage deletion cannot share a transaction with PostgreSQL. History rows are
-- therefore deleted only after an object-cleanup receipt is committed in the
-- same transaction. Removing an orphan upload uses the same durable retry queue.
create table if not exists public.generated_media_cleanup_jobs (
  object_key text primary key,
  user_id uuid not null,
  conversation_id uuid not null,
  generation_id uuid not null,
  reason text not null check (reason in ('history_delete', 'orphan_upload')),
  attempts integer not null default 0 check (attempts >= 0),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

alter table public.generated_media_cleanup_jobs enable row level security;
drop policy if exists generated_media_cleanup_service_role
  on public.generated_media_cleanup_jobs;
create policy generated_media_cleanup_service_role
  on public.generated_media_cleanup_jobs
  for all to service_role
  using (true)
  with check (true);
revoke all on table public.generated_media_cleanup_jobs
  from public, anon, authenticated;
grant select, insert, update, delete on table public.generated_media_cleanup_jobs
  to service_role;

create or replace function public.delete_messages_with_media_cleanup(
  p_user_id uuid,
  p_message_ids uuid[],
  p_object_keys text[] default array[]::text[]
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  requested_count integer;
  target_count integer;
  deleted_count integer;
begin
  requested_count := cardinality(p_message_ids);
  if p_user_id is null or p_message_ids is null
     or requested_count < 1 or requested_count > 100
     or requested_count <> (
       select count(distinct message_id) from unnest(p_message_ids) as message_id
     )
     or cardinality(coalesce(p_object_keys, array[]::text[])) > 400 then
    raise exception 'invalid_history_delete_request' using errcode = '22023';
  end if;

  perform 1
  from public.messages
  where user_id = p_user_id and id = any(p_message_ids)
  order by id
  for update;
  select count(*) into target_count
  from public.messages
  where user_id = p_user_id and id = any(p_message_ids);
  if target_count <> requested_count then
    raise exception 'history_messages_not_found' using errcode = 'P0002';
  end if;

  -- Claim takes a key-share lock on this parent. The update lock closes the
  -- check/delete race with a generation that is starting concurrently.
  perform 1
  from public.conversations
  where user_id = p_user_id
    and id in (
      select conversation_id from public.messages
      where user_id = p_user_id and id = any(p_message_ids)
    )
  order by id
  for update;
  if exists (
    select 1
    from public.chat_generations as generation
    where generation.user_id = p_user_id
      and generation.status in ('queued', 'running')
      and generation.conversation_id in (
        select conversation_id from public.messages
        where user_id = p_user_id and id = any(p_message_ids)
      )
  ) then
    raise exception 'active_generation_history_delete' using errcode = '55000';
  end if;

  if exists (
    select 1
    from unnest(coalesce(p_object_keys, array[]::text[])) as object_key
    where object_key is null
      or object_key !~* (
      '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/'
      || '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/'
      || '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/'
      || '[A-Za-z0-9][A-Za-z0-9_-]{0,127}[.](png|jpg|webp|gif|mp4|webm|mov)$'
    )
      or split_part(object_key, '/', 1) <> p_user_id::text
      or split_part(object_key, '/', 2)::uuid not in (
        select conversation_id from public.messages
        where user_id = p_user_id and id = any(p_message_ids)
      )
  ) then
    raise exception 'invalid_generated_media_cleanup_key' using errcode = '22023';
  end if;

  insert into public.generated_media_cleanup_jobs (
    object_key, user_id, conversation_id, generation_id, reason
  )
  select distinct object_key,
    p_user_id,
    split_part(object_key, '/', 2)::uuid,
    split_part(object_key, '/', 3)::uuid,
    'history_delete'
  from unnest(coalesce(p_object_keys, array[]::text[])) as object_key
  on conflict (object_key) do update set
    reason = excluded.reason,
    updated_at = now(),
    completed_at = null;

  delete from public.messages
  where user_id = p_user_id and id = any(p_message_ids);
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

create or replace function public.delete_conversation_with_media_cleanup(
  p_user_id uuid,
  p_conversation_id uuid,
  p_object_keys text[] default array[]::text[]
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  deleted_count integer;
begin
  if p_user_id is null or p_conversation_id is null
     or cardinality(coalesce(p_object_keys, array[]::text[])) > 400 then
    raise exception 'invalid_history_delete_request' using errcode = '22023';
  end if;

  perform 1
  from public.conversations
  where id = p_conversation_id and user_id = p_user_id
  for update;
  if not found then
    raise exception 'history_conversation_not_found' using errcode = 'P0002';
  end if;
  if exists (
    select 1 from public.chat_generations
    where user_id = p_user_id
      and conversation_id = p_conversation_id
      and status in ('queued', 'running')
  ) then
    raise exception 'active_generation_history_delete' using errcode = '55000';
  end if;

  if exists (
    select 1
    from unnest(coalesce(p_object_keys, array[]::text[])) as object_key
    where object_key is null
      or object_key !~* (
      '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/'
      || '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/'
      || '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/'
      || '[A-Za-z0-9][A-Za-z0-9_-]{0,127}[.](png|jpg|webp|gif|mp4|webm|mov)$'
    )
      or split_part(object_key, '/', 1) <> p_user_id::text
      or split_part(object_key, '/', 2) <> p_conversation_id::text
  ) then
    raise exception 'invalid_generated_media_cleanup_key' using errcode = '22023';
  end if;

  insert into public.generated_media_cleanup_jobs (
    object_key, user_id, conversation_id, generation_id, reason
  )
  select distinct object_key,
    p_user_id,
    p_conversation_id,
    split_part(object_key, '/', 3)::uuid,
    'history_delete'
  from unnest(coalesce(p_object_keys, array[]::text[])) as object_key
  on conflict (object_key) do update set
    reason = excluded.reason,
    updated_at = now(),
    completed_at = null;

  delete from public.conversations
  where id = p_conversation_id and user_id = p_user_id;
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

revoke all on function public.delete_messages_with_media_cleanup(uuid,uuid[],text[])
  from public, anon, authenticated;
revoke all on function public.delete_conversation_with_media_cleanup(uuid,uuid,text[])
  from public, anon, authenticated;
grant execute on function public.delete_messages_with_media_cleanup(uuid,uuid[],text[])
  to service_role;
grant execute on function public.delete_conversation_with_media_cleanup(uuid,uuid,text[])
  to service_role;

-- Define readiness last so a partially applied migration can never report ready.
-- The probe covers every primitive required by the multi-instance runtime.
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
    and has_column_privilege(
      'authenticated', 'public.chat_generations', 'status', 'UPDATE'
    )
    and not has_column_privilege(
      'authenticated', 'public.chat_generations', 'assistant_message_id', 'UPDATE'
    )
    and not has_column_privilege(
      'authenticated', 'public.chat_generations', 'lease_owner', 'UPDATE'
    )
    and not has_column_privilege(
      'authenticated', 'public.chat_generations', 'lease_version', 'UPDATE'
    )
    and not has_column_privilege(
      'authenticated', 'public.chat_generations', 'media', 'UPDATE'
    )
    and exists (
      select 1
      from pg_catalog.pg_trigger
      where tgname = 'preserve_chat_generation_terminal_status'
        and tgrelid = 'public.chat_generations'::regclass
        and not tgisinternal
    )
    and exists (
      select 1
      from pg_catalog.pg_trigger
      where tgname = 'preserve_terminal_generation_message'
        and tgrelid = 'public.messages'::regclass
        and not tgisinternal
    )
    and exists (
      select 1
      from pg_catalog.pg_trigger
      where tgname = 'reject_active_generation_message_delete'
        and tgrelid = 'public.messages'::regclass
        and not tgisinternal
    );
$$;

revoke all on function public.runtime_healthcheck_v2() from public, anon, authenticated;
grant execute on function public.runtime_healthcheck_v2() to service_role;

commit;
