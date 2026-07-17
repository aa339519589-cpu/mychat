#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DB="mychat_generation_migration_test"
PSQL=(psql -v ON_ERROR_STOP=1)

cleanup() {
  if [[ -n "${CUTOVER_PID:-}" ]] && kill -0 "$CUTOVER_PID" >/dev/null 2>&1; then
    kill -9 "$CUTOVER_PID" >/dev/null 2>&1 || true
    wait "$CUTOVER_PID" >/dev/null 2>&1 || true
  fi
  if [[ -n "${CHAOS_PID:-}" ]] && kill -0 "$CHAOS_PID" >/dev/null 2>&1; then
    kill -9 "$CHAOS_PID" >/dev/null 2>&1 || true
    wait "$CHAOS_PID" >/dev/null 2>&1 || true
  fi
  if [[ -n "${BILLING_LOCK_PID:-}" ]] && kill -0 "$BILLING_LOCK_PID" >/dev/null 2>&1; then
    kill -9 "$BILLING_LOCK_PID" >/dev/null 2>&1 || true
    wait "$BILLING_LOCK_PID" >/dev/null 2>&1 || true
  fi
  [[ -z "${CUTOVER_LOG:-}" ]] || rm -f "$CUTOVER_LOG"
  [[ -z "${CHAOS_LOG:-}" ]] || rm -f "$CHAOS_LOG"
  [[ -z "${BILLING_LOCK_LOG:-}" ]] || rm -f "$BILLING_LOCK_LOG"
  "${PSQL[@]}" -d postgres >/dev/null 2>&1 <<SQL || true
select pg_terminate_backend(pid) from pg_stat_activity where datname = '${DB}';
drop database if exists ${DB};
SQL
}
trap cleanup EXIT

"${PSQL[@]}" -d postgres <<SQL
do \$\$
begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin; end if;
end;
\$\$;
select pg_terminate_backend(pid) from pg_stat_activity where datname = '${DB}';
drop database if exists ${DB};
create database ${DB};
SQL

"${PSQL[@]}" -d "$DB" <<'SQL'
create schema auth;
create schema storage;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
create table auth.users (id uuid primary key);
create table public.conversations (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null default 'test',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.messages (
  id uuid primary key,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null,
  content text not null default '',
  images jsonb,
  thinking text,
  created_at timestamptz not null default now()
);
create table public.chat_generations (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  assistant_message_id uuid not null,
  status text not null default 'running'
    check (status in ('queued','running','completed','failed','cancelled')),
  content text not null default '',
  thinking text not null default '',
  sequence integer not null default 0,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table storage.buckets (
  id text primary key,
  name text not null,
  public boolean not null default false,
  file_size_limit bigint,
  allowed_mime_types text[]
);
create table storage.objects (
  id bigint generated always as identity primary key,
  bucket_id text not null references storage.buckets(id),
  name text not null,
  unique(bucket_id, name)
);
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.chat_generations enable row level security;
alter table storage.objects enable row level security;
create policy conversations_owner on public.conversations
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy messages_owner on public.messages
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy chat_generations_select on public.chat_generations
  for select using (auth.uid() = user_id);
create policy chat_generations_insert on public.chat_generations
  for insert with check (auth.uid() = user_id);
create policy chat_generations_update on public.chat_generations
  for update using (auth.uid() = user_id);
create policy "generated_media_upload_own" on storage.objects
  for insert to authenticated with check (true);
create policy "generated_media_update_own" on storage.objects
  for update to authenticated using (true);
create policy "generated_media_delete_own" on storage.objects
  for delete to authenticated using (true);
create policy "generated_media_public_read" on storage.objects
  for select using (bucket_id = 'generated-media');
insert into storage.buckets(id,name,public,file_size_limit)
values ('generated-media','generated-media',true,10485760);
grant usage on schema public, auth, storage to anon, authenticated, service_role;
grant select, insert, update, delete on public.conversations, public.messages to authenticated;
grant select, insert, update, delete on public.chat_generations to authenticated;
grant select, insert, update, delete on storage.objects to authenticated;
grant select, insert, update, delete on all tables in schema public to service_role;
grant select, insert, update, delete on all tables in schema storage to service_role;
SQL

"${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20260713030000_runtime_scaling.sql" >/dev/null

"${PSQL[@]}" -d "$DB" <<'SQL'
insert into auth.users(id) values
  ('00000000-0000-4000-8000-000000000001'),
  ('00000000-0000-4000-8000-000000000002');
insert into public.conversations(id,user_id,updated_at) values
  ('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','2000-01-01'),
  ('10000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','2000-01-01'),
  ('10000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000001','2000-01-01'),
  ('10000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000002','2000-01-01');
insert into storage.objects(bucket_id,name) values
  ('generated-media','00000000-0000-4000-8000-000000000001/10000000-0000-4000-8000-000000000001/legacy.png'),
  ('generated-media','00000000-0000-4000-8000-000000000001/10000000-0000-4000-8000-000000000003/bad.png');
insert into public.messages(id,conversation_id,user_id,role,content,thinking,images) values
  ('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','assistant','browser stale','browser stale',jsonb_build_object(
    'refs',jsonb_build_array('keep'),'image_summary','keep summary','generated_media',jsonb_build_array(jsonb_build_object(
      'type','image','url','https://project.supabase.co/storage/v1/object/public/generated-media/00000000-0000-4000-8000-000000000001/10000000-0000-4000-8000-000000000001/legacy.png','mimeType','image/png')))),
  ('20000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','assistant','','',null),
  ('20000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','assistant','','',null),
  ('20000000-0000-4000-8000-000000000004','10000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000001','assistant','bad browser','',jsonb_build_object(
    'generated_media',jsonb_build_array(jsonb_build_object(
      'type','image','url','https://evil.example/storage/v1/object/public/generated-media/00000000-0000-4000-8000-000000000001/10000000-0000-4000-8000-000000000003/bad.png','mimeType','image/png')))),
  ('20000000-0000-4000-8000-000000000005','10000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000002','assistant','','',null);
insert into public.chat_generations(
  id,user_id,conversation_id,assistant_message_id,status,content,thinking,sequence,error,updated_at
) values
  ('30000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','completed','old canonical','old think',2,null,'2001-01-01'),
  ('30000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','completed','winning canonical','winning think',5,null,'2002-01-01'),
  ('30000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000002','running','loser','',1,null,'2001-01-01'),
  ('30000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000003','running','winner','',2,null,'2002-01-01'),
  ('30000000-0000-4000-8000-000000000005','00000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002','29999999-0000-4000-8000-000000000099','running','orphan','',9,null,'2003-01-01'),
  ('30000000-0000-4000-8000-000000000006','00000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000003','20000000-0000-4000-8000-000000000004','completed','bad canonical','',1,null,now());
SQL

"${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20260713040000_generation_leases.sql" >/dev/null

"${PSQL[@]}" -d "$DB" <<'SQL'
do $$
begin
  if not public.runtime_healthcheck_v2() then raise exception '0400 readiness failed'; end if;
  if (select count(*) from public.chat_generations where assistant_message_id='20000000-0000-4000-8000-000000000001') <> 1 then
    raise exception 'assistant generation dedupe failed';
  end if;
  if exists (select 1 from public.chat_generations where id in ('30000000-0000-4000-8000-000000000003','30000000-0000-4000-8000-000000000005')) then
    raise exception 'legacy active/orphan cleanup failed';
  end if;
  if exists (select 1 from public.messages where id='20000000-0000-4000-8000-000000000002') then
    raise exception 'losing active placeholder was left behind';
  end if;
  if (select jsonb_array_length(media) from public.chat_generations where id='30000000-0000-4000-8000-000000000002') <> 1 then
    raise exception 'durable legacy media was not recovered';
  end if;
  if (select media from public.chat_generations where id='30000000-0000-4000-8000-000000000006') <> '[]'::jsonb then
    raise exception 'untrusted legacy media was promoted';
  end if;
  if (select content from public.messages where id='20000000-0000-4000-8000-000000000001') <> 'winning canonical' then
    raise exception 'terminal content backfill failed';
  end if;
  if (select images->'generation'->>'status' from public.messages where id='20000000-0000-4000-8000-000000000001') <> 'completed' then
    raise exception 'terminal metadata backfill failed';
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname='chat_generations_assistant_message_fkey' and convalidated
  ) then raise exception 'assistant FK was not validated'; end if;
end;
$$;
SQL

# The expand migration is retry-safe before the contract phase.
"${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20260713040000_generation_leases.sql" >/dev/null

"${PSQL[@]}" -d "$DB" <<'SQL'
insert into public.conversations(id,user_id,updated_at) values
  ('10000000-0000-4000-8000-000000000006','00000000-0000-4000-8000-000000000001','2000-01-01'),
  ('10000000-0000-4000-8000-000000000007','00000000-0000-4000-8000-000000000001','2000-01-01');
insert into public.messages(id,conversation_id,user_id,role,content,images) values
  ('20000000-0000-4000-8000-000000000061','10000000-0000-4000-8000-000000000006','00000000-0000-4000-8000-000000000001','assistant','',jsonb_build_object('refs',jsonb_build_array('keep'),'image_summary','summary')),
  ('20000000-0000-4000-8000-000000000062','10000000-0000-4000-8000-000000000006','00000000-0000-4000-8000-000000000001','assistant','',null),
  ('20000000-0000-4000-8000-000000000063','10000000-0000-4000-8000-000000000007','00000000-0000-4000-8000-000000000001','assistant','',null);
insert into storage.objects(bucket_id,name) values
  ('generated-media','00000000-0000-4000-8000-000000000001/10000000-0000-4000-8000-000000000006/40000000-0000-4000-8000-000000000061/asset.png');

do $$
declare result jsonb;
begin
  result := public.claim_chat_generation(
    '40000000-0000-4000-8000-000000000061','00000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000006','20000000-0000-4000-8000-000000000061',
    '50000000-0000-4000-8000-000000000061',45
  );
  if result->>'acquired' <> 'true' then raise exception 'initial claim failed: %', result; end if;
  result := public.claim_chat_generation(
    '40000000-0000-4000-8000-000000000062','00000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000006','20000000-0000-4000-8000-000000000061',
    '50000000-0000-4000-8000-000000000062',45
  );
  if result->>'reason' <> 'assistant_conflict' then raise exception 'assistant conflict missing: %', result; end if;
  result := public.claim_chat_generation(
    '40000000-0000-4000-8000-000000000063','00000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000006','20000000-0000-4000-8000-000000000062',
    '50000000-0000-4000-8000-000000000063',45
  );
  if result->>'reason' <> 'conversation_active' then raise exception 'conversation conflict missing: %', result; end if;
end;
$$;

set role authenticated;
set request.jwt.claim.sub='00000000-0000-4000-8000-000000000001';
do $$
begin
  begin
    delete from public.messages where id='20000000-0000-4000-8000-000000000061';
    raise exception 'active placeholder delete unexpectedly succeeded';
  exception when sqlstate '55000' then null;
  end;
  begin
    update public.messages set role='user' where id='20000000-0000-4000-8000-000000000061';
    raise exception 'active placeholder identity update unexpectedly succeeded';
  exception when sqlstate '55000' then null;
  end;
  begin
    insert into public.chat_generations(id,user_id,conversation_id,assistant_message_id,status)
    values (
      '40000000-0000-4000-8000-000000000069','00000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000006','20000000-0000-4000-8000-000000000005','running'
    );
    raise exception 'cross-user assistant occupation unexpectedly succeeded';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.chat_generations
    set assistant_message_id='20000000-0000-4000-8000-000000000062'
    where id='40000000-0000-4000-8000-000000000061';
    raise exception 'generation identity retarget unexpectedly succeeded';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset role;

do $$
declare result jsonb;
begin
  result := public.finalize_chat_generation(
    '40000000-0000-4000-8000-000000000061','00000000-0000-4000-8000-000000000001',
    '50000000-0000-4000-8000-000000000061',1,'completed','canonical result','canonical think',3,null,
    jsonb_build_array(jsonb_build_object(
      'type','image','url','https://project.supabase.co/storage/v1/object/public/generated-media/00000000-0000-4000-8000-000000000001/10000000-0000-4000-8000-000000000006/40000000-0000-4000-8000-000000000061/asset.png','mimeType','image/png'))
  );
  if result->>'status' <> 'completed' then raise exception 'finalize failed: %', result; end if;
  if (select images->'generation'->>'sequence' from public.messages where id='20000000-0000-4000-8000-000000000061') <> '3' then
    raise exception 'message terminal sequence missing';
  end if;
  if (select images->'refs' from public.messages where id='20000000-0000-4000-8000-000000000061') <> '["keep"]'::jsonb then
    raise exception 'message refs were lost';
  end if;
  if (select updated_at from public.conversations where id='10000000-0000-4000-8000-000000000006') <= '2000-01-02' then
    raise exception 'conversation terminal timestamp not advanced';
  end if;
end;
$$;

set role authenticated;
set request.jwt.claim.sub='00000000-0000-4000-8000-000000000001';
do $$
begin
  begin
    update public.messages set content='late stale', thinking='late stale'
    where id='20000000-0000-4000-8000-000000000061';
    raise exception 'terminal stale update unexpectedly succeeded';
  exception when sqlstate '55000' then null;
  end;
  update public.messages
  set images=jsonb_build_object('refs',jsonb_build_array('new-ref'),'image_summary','new summary')
  where id='20000000-0000-4000-8000-000000000061';
end;
$$;
reset role;

do $$
declare result jsonb;
begin
  if (select content from public.messages where id='20000000-0000-4000-8000-000000000061') <> 'canonical result' then
    raise exception 'late update changed canonical content';
  end if;
  if (select images->'refs' from public.messages where id='20000000-0000-4000-8000-000000000061') <> '["new-ref"]'::jsonb then
    raise exception 'legal refs update failed';
  end if;
  if jsonb_array_length((select images->'generated_media' from public.messages where id='20000000-0000-4000-8000-000000000061')) <> 1 then
    raise exception 'refs update erased canonical media';
  end if;
  result := public.claim_chat_generation(
    '40000000-0000-4000-8000-000000000063','00000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000006','20000000-0000-4000-8000-000000000062',
    '50000000-0000-4000-8000-000000000063',45
  );
  if result->>'acquired' <> 'true' then raise exception 'post-terminal claim failed: %', result; end if;
  result := public.cancel_chat_generation(
    '40000000-0000-4000-8000-000000000063','00000000-0000-4000-8000-000000000001'
  );
  if result->>'status' <> 'cancelled' or result->'media' <> '[]'::jsonb then
    raise exception 'cancel CAS failed: %', result;
  end if;
  result := public.finalize_chat_generation(
    '40000000-0000-4000-8000-000000000063','00000000-0000-4000-8000-000000000001',
    '50000000-0000-4000-8000-000000000063',1,'completed','lost','',2,null,'[]'::jsonb
  );
  if result->>'status' <> 'cancelled' or result->'media' <> '[]'::jsonb then
    raise exception 'cancel did not beat finalize: %', result;
  end if;
end;
$$;

set role authenticated;
set request.jwt.claim.sub='00000000-0000-4000-8000-000000000001';
delete from public.messages where id='20000000-0000-4000-8000-000000000062';
reset role;
do $$
begin
  if exists (select 1 from public.chat_generations where id='40000000-0000-4000-8000-000000000063') then
    raise exception 'terminal message delete did not cascade generation cleanup';
  end if;
end;
$$;

-- History deletion commits its Storage cleanup receipt atomically with the row
-- delete, and a parent lock prevents a concurrent active generation race.
insert into public.conversations(id,user_id,updated_at) values
  ('10000000-0000-4000-8000-000000000009','00000000-0000-4000-8000-000000000001','2000-01-01'),
  ('10000000-0000-4000-8000-000000000010','00000000-0000-4000-8000-000000000001','2000-01-01'),
  ('10000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000001','2000-01-01');
insert into public.messages(id,conversation_id,user_id,role,content) values
  ('20000000-0000-4000-8000-000000000071','10000000-0000-4000-8000-000000000009','00000000-0000-4000-8000-000000000001','user','delete me'),
  ('20000000-0000-4000-8000-000000000072','10000000-0000-4000-8000-000000000010','00000000-0000-4000-8000-000000000001','user','keep while active'),
  ('20000000-0000-4000-8000-000000000073','10000000-0000-4000-8000-000000000010','00000000-0000-4000-8000-000000000001','assistant',''),
  ('20000000-0000-4000-8000-000000000074','10000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000001','user','delete conversation');
do $$
declare
  deleted integer;
  result jsonb;
  message_key text := '00000000-0000-4000-8000-000000000001/10000000-0000-4000-8000-000000000009/40000000-0000-4000-8000-000000000071/asset.png';
  conversation_key text := '00000000-0000-4000-8000-000000000001/10000000-0000-4000-8000-000000000011/40000000-0000-4000-8000-000000000074/asset.webp';
begin
  deleted := public.delete_messages_with_media_cleanup(
    '00000000-0000-4000-8000-000000000001',
    array['20000000-0000-4000-8000-000000000071'::uuid],
    array[message_key]
  );
  if deleted <> 1 or exists (
    select 1 from public.messages where id='20000000-0000-4000-8000-000000000071'
  ) then raise exception 'atomic message history delete failed'; end if;
  if not exists (
    select 1 from public.generated_media_cleanup_jobs
    where object_key=message_key and completed_at is null and reason='history_delete'
  ) then raise exception 'message cleanup receipt was not committed'; end if;

  result := public.claim_chat_generation(
    '40000000-0000-4000-8000-000000000073','00000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000010','20000000-0000-4000-8000-000000000073',
    '50000000-0000-4000-8000-000000000073',45
  );
  if result->>'acquired' <> 'true' then raise exception 'history guard claim failed'; end if;
  begin
    perform public.delete_messages_with_media_cleanup(
      '00000000-0000-4000-8000-000000000001',
      array['20000000-0000-4000-8000-000000000072'::uuid],
      array[]::text[]
    );
    raise exception 'active conversation history delete unexpectedly succeeded';
  exception when sqlstate '55000' then null;
  end;
  if not exists (
    select 1 from public.messages where id='20000000-0000-4000-8000-000000000072'
  ) then raise exception 'active history guard deleted the message'; end if;
  perform public.cancel_chat_generation(
    '40000000-0000-4000-8000-000000000073','00000000-0000-4000-8000-000000000001'
  );

  deleted := public.delete_conversation_with_media_cleanup(
    '00000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000011',
    array[conversation_key]
  );
  if deleted <> 1 or exists (
    select 1 from public.conversations where id='10000000-0000-4000-8000-000000000011'
  ) then raise exception 'atomic conversation history delete failed'; end if;
  if not exists (
    select 1 from public.generated_media_cleanup_jobs
    where object_key=conversation_key and completed_at is null and reason='history_delete'
  ) then raise exception 'conversation cleanup receipt was not committed'; end if;
end;
$$;

-- A different generation id in the same conversation must settle an expired
-- active row instead of leaving the partial unique index as a permanent lock.
insert into public.conversations(id,user_id,updated_at)
values ('10000000-0000-4000-8000-000000000008','00000000-0000-4000-8000-000000000001','2000-01-01');
insert into public.messages(id,conversation_id,user_id,role,content) values
  ('20000000-0000-4000-8000-000000000064','10000000-0000-4000-8000-000000000008','00000000-0000-4000-8000-000000000001','assistant',''),
  ('20000000-0000-4000-8000-000000000065','10000000-0000-4000-8000-000000000008','00000000-0000-4000-8000-000000000001','assistant','');
do $$
declare result jsonb;
begin
  result := public.claim_chat_generation(
    '40000000-0000-4000-8000-000000000064','00000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000008','20000000-0000-4000-8000-000000000064',
    '50000000-0000-4000-8000-000000000064',45
  );
  if result->>'acquired' <> 'true' then raise exception 'stale fixture claim failed'; end if;
  update public.chat_generations set lease_expires_at=clock_timestamp()-interval '1 second'
  where id='40000000-0000-4000-8000-000000000064';
  result := public.claim_chat_generation(
    '40000000-0000-4000-8000-000000000065','00000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000008','20000000-0000-4000-8000-000000000065',
    '50000000-0000-4000-8000-000000000065',45
  );
  if result->>'reason' <> 'stale' then raise exception 'expired conversation was not settled: %', result; end if;
  result := public.claim_chat_generation(
    '40000000-0000-4000-8000-000000000065','00000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000008','20000000-0000-4000-8000-000000000065',
    '50000000-0000-4000-8000-000000000065',45
  );
  if result->>'acquired' <> 'true' then raise exception 'retry after stale settlement failed: %', result; end if;
  perform public.cancel_chat_generation(
    '40000000-0000-4000-8000-000000000065','00000000-0000-4000-8000-000000000001'
  );
end;
$$;

-- Simulate a legacy split write during the expand window. 0500 must reconcile it.
insert into public.chat_generations(id,user_id,conversation_id,assistant_message_id,status,content,thinking,sequence,error)
values (
  '40000000-0000-4000-8000-000000000070','00000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000007','20000000-0000-4000-8000-000000000063',
  'running','','',0,null
);
set role authenticated;
set request.jwt.claim.sub='00000000-0000-4000-8000-000000000001';
update public.chat_generations
set status='failed', content='expand terminal', thinking='expand think', sequence=4, error='expand_failed'
where id='40000000-0000-4000-8000-000000000070';
reset role;
SQL

"${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20260713050000_generation_lease_contract.sql" >/dev/null

"${PSQL[@]}" -d "$DB" <<'SQL'
do $$
declare
  column_name text;
begin
  if not public.runtime_healthcheck_v2() then raise exception '0500 readiness failed'; end if;
  if (select content from public.messages where id='20000000-0000-4000-8000-000000000063') <> 'expand terminal' then
    raise exception 'contract reconciliation missed expand-window terminal';
  end if;
  if (select images->'generation'->>'error' from public.messages where id='20000000-0000-4000-8000-000000000063') <> 'expand_failed' then
    raise exception 'contract reconciliation missed terminal metadata';
  end if;
  foreach column_name in array array[
    'id', 'user_id', 'conversation_id', 'assistant_message_id',
    'status', 'content', 'thinking', 'sequence', 'error',
    'lease_owner', 'lease_expires_at', 'lease_version', 'cancel_requested_at',
    'media', 'created_at', 'updated_at'
  ] loop
    if has_column_privilege('authenticated','public.chat_generations',column_name,'UPDATE')
       or has_column_privilege('anon','public.chat_generations',column_name,'UPDATE') then
      raise exception 'contract left % column writable', column_name;
    end if;
  end loop;
  if has_table_privilege('authenticated','public.messages','DELETE')
    or has_table_privilege('authenticated','public.conversations','DELETE') then
    raise exception 'contract left direct history delete writable';
  end if;
  if exists (
    select 1 from pg_policies
    where schemaname='storage' and tablename='objects'
      and policyname in ('generated_media_upload_own','generated_media_update_own','generated_media_delete_own')
  ) then raise exception 'contract left generated media browser write policy'; end if;
end;
$$;
SQL

"${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20260713060000_rate_limit_timestamp_fix.sql" >/dev/null

"${PSQL[@]}" -d "$DB" <<'SQL'
begin;
delete from public.api_rate_limits
where key_hash in (repeat('a', 64), repeat('b', 64), repeat('0', 64));
insert into public.api_rate_limits(key_hash, request_count, reset_at, updated_at)
values (repeat('b', 64), 1, now() - interval '2 days', now() - interval '2 days');

set local role service_role;
do $$
declare
  result record;
begin
  select * into result
  from public.consume_api_rate_limit(repeat('a', 64), 2, 60000);
  if result.allowed is not true or result.remaining <> 1 or result.retry_after_seconds <> 0 then
    raise exception 'rate limit insert branch failed: %', result;
  end if;

  select * into result
  from public.consume_api_rate_limit(repeat('a', 64), 2, 60000);
  if result.allowed is not true or result.remaining <> 0 or result.retry_after_seconds <> 0 then
    raise exception 'rate limit conflict branch failed: %', result;
  end if;

  select * into result
  from public.consume_api_rate_limit(repeat('a', 64), 2, 60000);
  if result.allowed is not false or result.remaining <> 0 or result.retry_after_seconds < 1 then
    raise exception 'rate limit rejection branch failed: %', result;
  end if;

  perform public.consume_api_rate_limit(repeat('0', 64), 2, 60000);
end;
$$;
reset role;

do $$
begin
  if exists (select 1 from public.api_rate_limits where key_hash = repeat('b', 64)) then
    raise exception 'rate limit stale cleanup branch failed';
  end if;
  if not public.runtime_healthcheck_v3() then
    raise exception '0600 readiness failed';
  end if;
  if not has_function_privilege(
    'service_role',
    'public.consume_api_rate_limit(text,integer,integer)',
    'EXECUTE'
  ) or has_function_privilege(
    'authenticated',
    'public.consume_api_rate_limit(text,integer,integer)',
    'EXECUTE'
  ) then
    raise exception 'rate limit execution privileges are unsafe';
  end if;
end;
$$;
rollback;
SQL

# The hotfix is retry-safe and must keep both its runtime behavior and readiness marker.
"${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20260713060000_rate_limit_timestamp_fix.sql" >/dev/null

"${PSQL[@]}" -d "$DB" <<'SQL'
do $$
begin
  if not public.runtime_healthcheck_v3() then raise exception '0600 retry readiness failed'; end if;
end;
$$;
SQL

# Exercise the atomic limiter under real cross-session contention. Exactly the
# configured limit may pass, regardless of how the 40 transactions interleave.
RATE_LIMIT_KEY="$(printf 'c%.0s' {1..64})"
"${PSQL[@]}" -d "$DB" -c "delete from public.api_rate_limits where key_hash='${RATE_LIMIT_KEY}'" >/dev/null
RATE_LIMIT_RESULTS="$({
  for _ in $(seq 1 40); do
    "${PSQL[@]}" -At -d "$DB" -c \
      "select allowed::integer from public.consume_api_rate_limit('${RATE_LIMIT_KEY}', 10, 60000)" &
  done
  wait
})"
RATE_LIMIT_ALLOWED="$(printf '%s\n' "$RATE_LIMIT_RESULTS" | grep -c '^1$')"
RATE_LIMIT_STORED="$("${PSQL[@]}" -At -d "$DB" -c \
  "select request_count from public.api_rate_limits where key_hash='${RATE_LIMIT_KEY}'")"
if [[ "$RATE_LIMIT_ALLOWED" != "10" || "$RATE_LIMIT_STORED" != "11" ]]; then
  echo "Concurrent rate-limit verification failed: allowed=${RATE_LIMIT_ALLOWED}, stored=${RATE_LIMIT_STORED}" >&2
  exit 1
fi

# Unified job control plane: apply the migration against the same PostgreSQL 16
# baseline, then exercise identity binding, fencing, terminal CAS, ledger/outbox
# atomicity, resumable-vs-unsafe stale leases, and tenant RLS.
"${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20260713070000_unified_job_control_plane.sql" >/dev/null
"${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20260713070000_unified_job_control_plane.sql" >/dev/null
"${PSQL[@]}" -d "$DB" -f "$ROOT/tests/job-control-plane-pg16.sql" >/dev/null

# GitHub credentials remain encrypted behind audited service-role-only RPCs.
# Re-applying the expand migration must remain safe before live traffic moves.
"${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20260713080000_github_connections.sql" >/dev/null
"${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20260713080000_github_connections.sql" >/dev/null
"${PSQL[@]}" -d "$DB" -f "$ROOT/tests/github-connection-pg16.sql" >/dev/null

# Fenced object receipts close the storage/terminal crash window; quota reads
# are derived from the same append-only ledger committed by finalize_job.
"${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20260713090000_job_assets_and_ledger_quota.sql" >/dev/null
"${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20260713090000_job_assets_and_ledger_quota.sql" >/dev/null
"${PSQL[@]}" -d "$DB" -f "$ROOT/tests/job-assets-ledger-pg16.sql" >/dev/null

# Outbox delivery and object cleanup use their own generation fence so a late
# acknowledgement can never cross an expired/reclaimed delivery lease.
"${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20260713100000_job_outbox_dispatch.sql" >/dev/null
"${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20260713100000_job_outbox_dispatch.sql" >/dev/null
"${PSQL[@]}" -d "$DB" -f "$ROOT/tests/job-outbox-pg16.sql" >/dev/null

# Generated media is private and served only through the application proxy;
# the final readiness contract includes the outbox and private-storage plane.
"${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20260713110000_private_generated_media.sql" >/dev/null
"${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20260713110000_private_generated_media.sql" >/dev/null
"${PSQL[@]}" -d "$DB" -f "$ROOT/tests/private-generated-media-pg16.sql" >/dev/null

# High-risk Agent actions require a database-authoritative, exact-plan-bound,
# expiring token whose approval can be consumed exactly once.
"${PSQL[@]}" -d "$DB" -c \
  "grant select on public.agent_tasks to authenticated, service_role" >/dev/null
"${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20260713120000_agent_confirmation_gates.sql" >/dev/null
"${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20260713120000_agent_confirmation_gates.sql" >/dev/null
"${PSQL[@]}" -d "$DB" -f "$ROOT/tests/agent-confirmation-gates-pg16.sql" >/dev/null

# The focused baseline supplies the legacy artifact table that exists in every
# production deployment before the content-addressed snapshot expand phase.
"${PSQL[@]}" -d "$DB" <<'SQL'
create table if not exists public.agent_artifacts (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.agent_tasks(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null default 'other',
  title text,
  content text,
  url text,
  meta jsonb,
  created_at timestamptz not null default now()
);
alter table public.agent_artifacts enable row level security;
drop policy if exists agent_artifacts_select on public.agent_artifacts;
create policy agent_artifacts_select on public.agent_artifacts for select
  using (auth.uid() = user_id);
drop policy if exists agent_artifacts_insert on public.agent_artifacts;
create policy agent_artifacts_insert on public.agent_artifacts for insert
  with check (auth.uid() = user_id and exists (
    select 1 from public.agent_tasks task where task.id = task_id and task.user_id = auth.uid()
  ));
drop policy if exists agent_artifacts_update on public.agent_artifacts;
create policy agent_artifacts_update on public.agent_artifacts for update
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists agent_artifacts_delete on public.agent_artifacts;
create policy agent_artifacts_delete on public.agent_artifacts for delete
  using (auth.uid() = user_id);
grant select, insert, update, delete on public.agent_artifacts to authenticated, service_role;
SQL
"${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20260713130000_agent_snapshot_cas.sql" >/dev/null
"${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20260713130000_agent_snapshot_cas.sql" >/dev/null
"${PSQL[@]}" -d "$DB" -f "$ROOT/tests/agent-snapshot-cas-pg16.sql" >/dev/null

# Operational signals must be derived from the shared system of record rather
# than any one web/worker process. Re-apply the trigger/rollup migration, then
# verify exact backfill, monotonic terminal counters, bounded labels and SLOs.
"${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20260713140000_authoritative_job_observability.sql" >/dev/null
"${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20260713140000_authoritative_job_observability.sql" >/dev/null
"${PSQL[@]}" -d "$DB" -f "$ROOT/tests/authoritative-job-observability-pg16.sql" >/dev/null

# Durable Agent publish, workspace current-head and paid-balance settlement are
# replayed twice against a production-shaped legacy Agent schema.
"${PSQL[@]}" -d "$DB" <<'SQL'
alter table public.agent_tasks
  add column if not exists goal text not null default 'test task',
  add column if not exists mode text not null default 'auto',
  add column if not exists repo text,
  add column if not exists branch text not null default 'main',
  add column if not exists meta jsonb,
  add column if not exists agent_branch text,
  add column if not exists pull_request_url text,
  add column if not exists pull_request_number integer,
  add column if not exists commit_sha text;
create table if not exists public.agent_workspaces (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.agent_tasks(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  repo text not null,
  branch text not null default 'main',
  path text,
  status text not null default 'ready',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.agent_workspaces enable row level security;
alter table public.profiles add column if not exists quota_version bigint not null default 0;
grant select,insert,update,delete on public.agent_tasks,public.agent_workspaces,public.agent_artifacts
  to authenticated,service_role;
SQL
"${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20260713150000_durable_agent_operations.sql" >/dev/null
"${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20260713150000_durable_agent_operations.sql" >/dev/null
"${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20260713160000_agent_workspace_authority.sql" >/dev/null
"${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20260713160000_agent_workspace_authority.sql" >/dev/null
"${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20260713170000_agent_atomicity_and_balance.sql" >/dev/null
"${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20260713170000_agent_atomicity_and_balance.sql" >/dev/null
"${PSQL[@]}" -d "$DB" -f "$ROOT/tests/agent-durable-control-plane-pg16.sql" >/dev/null
"${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20260713180000_checkpoint_recovery_contract.sql" >/dev/null
"${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20260713180000_checkpoint_recovery_contract.sql" >/dev/null
"${PSQL[@]}" -d "$DB" -f "$ROOT/tests/checkpoint-recovery-pg16.sql" >/dev/null
"${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20260713190000_agent_publication_safety.sql" >/dev/null
"${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20260713190000_agent_publication_safety.sql" >/dev/null
"${PSQL[@]}" -d "$DB" -f "$ROOT/tests/agent-publication-safety-pg16.sql" >/dev/null
"${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20260713200000_job_worker_heartbeats.sql" >/dev/null
"${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20260713200000_job_worker_heartbeats.sql" >/dev/null
"${PSQL[@]}" -d "$DB" -f "$ROOT/tests/job-worker-heartbeat-pg16.sql" >/dev/null
"${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20260713210000_job_outbox_redrive.sql" >/dev/null
"${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20260713210000_job_outbox_redrive.sql" >/dev/null
"${PSQL[@]}" -d "$DB" -f "$ROOT/tests/outbox-redrive-pg16.sql" >/dev/null
"${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20260713220000_job_budget_accounting.sql" >/dev/null
"${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20260713220000_job_budget_accounting.sql" >/dev/null
"${PSQL[@]}" -d "$DB" -f "$ROOT/tests/job-budget-accounting-pg16.sql" >/dev/null
"${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20260713230000_awaiting_job_resume.sql" >/dev/null
"${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20260713230000_awaiting_job_resume.sql" >/dev/null
"${PSQL[@]}" -d "$DB" -f "$ROOT/tests/awaiting-job-resume-pg16.sql" >/dev/null
"${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20260713240000_admission_and_reservations.sql" >/dev/null
"${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20260713240000_admission_and_reservations.sql" >/dev/null
"${PSQL[@]}" -d "$DB" -f "$ROOT/tests/job-admission-reservations-pg16.sql" >/dev/null
"${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20260713250000_terminal_projection_and_effect_recovery.sql" >/dev/null
"${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20260713250000_terminal_projection_and_effect_recovery.sql" >/dev/null
"${PSQL[@]}" -d "$DB" -f "$ROOT/tests/terminal-projection-effect-recovery-pg16.sql" >/dev/null
"${PSQL[@]}" -d "$DB" <<'SQL'
create table if not exists public.projects (
  id uuid primary key,
  user_id uuid not null references auth.users(id),
  name text not null default '',
  instructions text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists public.project_files (
  id uuid primary key,
  project_id uuid not null references public.projects(id) on delete cascade,
  user_id uuid not null references auth.users(id),
  name text not null,
  content text,
  created_at timestamptz not null default now()
);
alter table storage.objects add column if not exists metadata jsonb;
insert into public.projects(id, user_id, name) values (
  '96200000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000001',
  'stream lifecycle cutover'
);
insert into storage.objects(bucket_id, name, metadata) values (
  'job-payloads',
  '00000000-0000-4000-8000-000000000001/96200000-0000-4000-8000-000000000004/'
    || repeat('c', 64) || '.json',
  '{"size":"64"}'::jsonb
);
SQL

# Hold an old-version write transaction open while the migration reaches its
# trigger DDL. The migration must wait, then include every committed row in its
# authoritative backfill; a scan-before-trigger implementation misses these.
CUTOVER_LOG="$(mktemp)"
PGAPPNAME=mychat-stream-cutover-writer "${PSQL[@]}" -d "$DB" >"$CUTOVER_LOG" 2>&1 <<'SQL' &
begin;
insert into public.project_files(id, project_id, user_id, name, content) values (
  '96200000-0000-4000-8000-000000000002',
  '96200000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000001',
  'cutover.txt', 'committed while migration waits'
);
insert into public.messages(id, conversation_id, user_id, role, content) values (
  '96200000-0000-4000-8000-000000000003',
  '80000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000001',
  'user', 'committed while lifecycle counters cut over'
);
set local role service_role;
select public.enqueue_job(
  '96200000-0000-4000-8000-000000000004',
  'cutover.payload', 'cutover_payload',
  '00000000-0000-4000-8000-000000000001', 'registered', '{}'::jsonb,
  'stream-lifecycle-cutover-payload', repeat('c', 64),
  jsonb_build_object(
    'billingClass', 'customer',
    'payloadRef', jsonb_build_object(
      'bucket', 'job-payloads',
      'objectKey',
        '00000000-0000-4000-8000-000000000001/96200000-0000-4000-8000-000000000004/'
          || repeat('c', 64) || '.json',
      'sha256', repeat('c', 64), 'bytes', 64,
      'contentType', 'application/json'
    )
  ),
  '{"wallTimeMs":60000}'::jsonb
);
select pg_sleep(2);
commit;
SQL
CUTOVER_PID=$!
CUTOVER_READY=0
for _ in {1..100}; do
  if [[ "$("${PSQL[@]}" -qAt -d "$DB" -c \
    "select count(*) from pg_stat_activity where application_name='mychat-stream-cutover-writer' and wait_event='PgSleep'")" == "1" ]]; then
    CUTOVER_READY=1
    break
  fi
  sleep 0.05
done
if [[ "$CUTOVER_READY" != "1" ]]; then
  cat "$CUTOVER_LOG" >&2
  echo "Stream lifecycle cutover writer did not reach its overlap point" >&2
  exit 1
fi
"${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20260713260000_stream_and_asset_lifecycle.sql" >/dev/null
if ! wait "$CUTOVER_PID"; then
  cat "$CUTOVER_LOG" >&2
  echo "Stream lifecycle cutover writer failed" >&2
  exit 1
fi
unset CUTOVER_PID
"${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20260713260000_stream_and_asset_lifecycle.sql" >/dev/null
"${PSQL[@]}" -d "$DB" -f "$ROOT/tests/stream-asset-lifecycle-pg16.sql" >/dev/null

# Supply the production-shaped tenant graph that is outside this focused
# migration baseline. Vector columns are irrelevant to relational validation.
"${PSQL[@]}" -d "$DB" <<'SQL'
alter table public.conversations
  add column if not exists project_id uuid references public.projects(id) on delete set null,
  add column if not exists summary_until_message_id uuid references public.messages(id) on delete set null;

create table if not exists public.project_memories (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  content text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz default now()
);

create table if not exists public.conversation_chunks (
  id uuid primary key,
  user_id uuid not null,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  project_id uuid references public.projects(id) on delete set null,
  conversation_title text,
  message_start_id uuid references public.messages(id) on delete set null,
  message_end_id uuid references public.messages(id) on delete set null,
  content text not null,
  content_hash text not null,
  token_count integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.artifacts (
  id uuid primary key,
  user_id uuid not null,
  conversation_id uuid references public.conversations(id) on delete cascade,
  message_id uuid references public.messages(id) on delete cascade,
  project_id uuid references public.projects(id) on delete set null,
  title text not null default 'test artifact',
  raw text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.agent_task_steps (
  id uuid primary key,
  task_id uuid not null references public.agent_tasks(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null default 'info',
  label text,
  detail text,
  seq integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.agent_tool_calls (
  id uuid primary key,
  task_id uuid not null references public.agent_tasks(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  step_id uuid references public.agent_task_steps(id) on delete set null,
  tool_name text not null,
  input jsonb,
  output jsonb,
  error text,
  status text not null default 'pending',
  started_at timestamptz,
  finished_at timestamptz,
  duration_ms integer,
  seq integer not null default 0,
  created_at timestamptz not null default now()
);
SQL

# Installing the latest health gate before the tenant expand is intentionally
# allowed, but it must fail closed until every required migration contract is
# present and validated.
"${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20260713280000_revision_scoped_worker_readiness.sql" >/dev/null
PRE_TENANT_HEALTH="$("${PSQL[@]}" -qAt -d "$DB" -c \
  "set role service_role; select public.runtime_healthcheck_v12()")"
if [[ "$PRE_TENANT_HEALTH" != "f" ]]; then
  echo "Runtime v12 accepted a database that skipped tenant integrity" >&2
  exit 1
fi

# A legacy single-column FK permits this ownership mismatch. The hardening
# migration must stop before contract, leaving evidence and the legacy FK in
# place while retaining its replayable NOT VALID expand work.
"${PSQL[@]}" -d "$DB" <<'SQL'
insert into public.projects(id, user_id, name) values (
  'a7ff0000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000002',
  'cross-tenant migration fixture'
);
insert into public.project_files(id, project_id, user_id, name, content) values (
  'a7ff0000-0000-4000-8000-000000000001',
  'a7ff0000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000001',
  'must-survive-failed-migration.txt',
  'operator-visible evidence'
);
SQL
if "${PSQL[@]}" -d "$DB" \
  -f "$ROOT/supabase/migrations/20260713270000_tenant_relational_integrity.sql" \
  >/dev/null 2>&1; then
  echo "Tenant integrity migration accepted cross-tenant legacy data" >&2
  exit 1
fi
TENANT_DIRTY_ROW_COUNT="$("${PSQL[@]}" -qAt -d "$DB" -c \
  "select count(*) from public.project_files where id='a7ff0000-0000-4000-8000-000000000001' and user_id='00000000-0000-4000-8000-000000000001' and project_id='a7ff0000-0000-4000-8000-000000000002'")"
if [[ "$TENANT_DIRTY_ROW_COUNT" != "1" ]]; then
  echo "Failed tenant migration silently changed cross-tenant evidence" >&2
  exit 1
fi
TENANT_FAILED_EXPAND_STATE="$("${PSQL[@]}" -qAt -d "$DB" -c \
  "select public.runtime_healthcheck_v12()::text || ':' || (select count(*) from pg_constraint where conrelid='public.project_files'::regclass and conname='project_files_tenant_project_fkey' and not convalidated) || ':' || (select count(*) from pg_constraint where conrelid='public.project_files'::regclass and conname='project_files_project_id_fkey' and convalidated)")"
if [[ "$TENANT_FAILED_EXPAND_STATE" != "false:1:1" ]]; then
  echo "Failed tenant expand was not replay-safe: ${TENANT_FAILED_EXPAND_STATE}" >&2
  exit 1
fi

# Fixture cleanup is explicit and outside the migration. A clean database must
# accept the migration repeatedly and enforce every relationship in PostgreSQL.
"${PSQL[@]}" -q -d "$DB" <<'SQL'
delete from public.project_files where id = 'a7ff0000-0000-4000-8000-000000000001';
delete from public.projects where id = 'a7ff0000-0000-4000-8000-000000000002';
SQL
"${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20260713270000_tenant_relational_integrity.sql" >/dev/null
"${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20260713270000_tenant_relational_integrity.sql" >/dev/null
"${PSQL[@]}" -d "$DB" -f "$ROOT/tests/tenant-relational-integrity-pg16.sql" >/dev/null
"${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20260713280000_revision_scoped_worker_readiness.sql" >/dev/null
"${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20260713280000_revision_scoped_worker_readiness.sql" >/dev/null
"${PSQL[@]}" -d "$DB" -f "$ROOT/tests/revision-scoped-worker-readiness-pg16.sql" >/dev/null

# Two independent commands racing on the same account serialize on the profile
# row. The full reservation fits once, never twice, and the loser leaves no job.
ADMISSION_RESULTS="$({
  "${PSQL[@]}" -qAt -d "$DB" -c \
    "set role service_role; select public.pg16_admission_attempt('89910000-0000-4000-8000-000000000001','89900000-0000-4000-8000-000000000001','admission-race-a')" &
  "${PSQL[@]}" -qAt -d "$DB" -c \
    "set role service_role; select public.pg16_admission_attempt('89910000-0000-4000-8000-000000000002','89900000-0000-4000-8000-000000000002','admission-race-b')" &
  wait
})"
ADMISSION_WINNERS="$(printf '%s\n' "$ADMISSION_RESULTS" | grep -c '^admitted$')"
ADMISSION_REJECTIONS="$(printf '%s\n' "$ADMISSION_RESULTS" | grep -c '^rejected$')"
ADMISSION_HELD_STATE="$("${PSQL[@]}" -qAt -d "$DB" -c \
  "select balance::text || ':' || (select count(*) from public.job_admission_reservations where principal_id=profiles.user_id and status='held') from public.profiles where user_id='00000000-0000-4000-8000-000000000002'")"
if [[ "$ADMISSION_WINNERS" != "1" || "$ADMISSION_REJECTIONS" != "1" || "$ADMISSION_HELD_STATE" != "5424:1" ]]; then
  echo "Concurrent admission verification failed: results=${ADMISSION_RESULTS}, state=${ADMISSION_HELD_STATE}" >&2
  exit 1
fi

# Settle 100 weighted tokens against the held maximum. The ledger trigger must
# not debit twice and terminal settlement must refund exactly the unused 24,476.
"${PSQL[@]}" -q -d "$DB" <<'SQL'
set role service_role;
do $$
declare
  v_job_id uuid;
  v_claim jsonb;
  v_result jsonb;
begin
  v_claim := public.claim_next_job('admission-settlement-worker',array['admission_race'],120);
  if coalesce(v_claim->'job'->>'id', '')
       not in ('89910000-0000-4000-8000-000000000001',
               '89910000-0000-4000-8000-000000000002') then
    raise exception 'reserved job was not claimable: %', v_claim;
  end if;
  v_job_id := (v_claim->'job'->>'id')::uuid;
  v_result := public.record_job_accounting(
    v_job_id,'admission-settlement-worker',1,1,
    jsonb_build_array(jsonb_build_object(
      'idempotencyKey',v_job_id::text || ':attempt:1:admission-usage',
      'reason','admission_test_usage','direction','debit',
      'weightedTokens',100,'rawTokens',100,'costEstimate',0.0003,
      'currency','USD','metadata',jsonb_build_object('attempt',1,'usingBalance',false)
    ))
  );
  if v_result->>'recorded' <> 'true' then raise exception 'usage was not recorded: %', v_result; end if;
  v_result := public.finalize_job(
    v_job_id,'admission-settlement-worker',1,'failed','{}'::jsonb,
    'internal','admission_test_terminal'
  );
  if v_result->>'status' <> 'failed' then raise exception 'fixture did not finalize: %', v_result; end if;
end;
$$;
SQL
ADMISSION_SETTLED_STATE="$("${PSQL[@]}" -qAt -d "$DB" -c \
  "select profile.balance::text || ':' || reservation.status || ':' || reservation.actual_tokens::text || ':' || reservation.released_tokens::text || ':' || settlement.debited_tokens::text from public.profiles profile join public.job_admission_reservations reservation on reservation.principal_id=profile.user_id join public.ledger_entries entry on entry.job_id=reservation.job_id join public.ledger_balance_settlements settlement on settlement.ledger_entry_id=entry.id where profile.user_id='00000000-0000-4000-8000-000000000002'")"
if [[ "$ADMISSION_SETTLED_STATE" != "29900:settled:100:24476:100" ]]; then
  echo "Admission settlement verification failed: ${ADMISSION_SETTLED_STATE}" >&2
  exit 1
fi

# Two concurrent deliveries of the same resume command must serialize on the
# job row: one commits the state transition, the other observes the durable
# idempotency receipt without adding a second checkpoint/event/audit mutation.
AWAITING_RESUME_RESULTS="$({
  "${PSQL[@]}" -qAt -d "$DB" -c \
    "set role service_role; set request.jwt.claim.role='service_role'; select (result->>'resumed') || ':' || (result->>'replayed') || ':' || coalesce(result->>'reason','ok') from (select public.resume_awaiting_job('89800000-0000-4000-8000-000000000005','00000000-0000-4000-8000-000000000001',1,'resume-request-concurrent','{\"answer\":\"continue\"}'::jsonb) result) response" &
  "${PSQL[@]}" -qAt -d "$DB" -c \
    "set role service_role; set request.jwt.claim.role='service_role'; select (result->>'resumed') || ':' || (result->>'replayed') || ':' || coalesce(result->>'reason','ok') from (select public.resume_awaiting_job('89800000-0000-4000-8000-000000000005','00000000-0000-4000-8000-000000000001',1,'resume-request-concurrent','{\"answer\":\"continue\"}'::jsonb) result) response" &
  wait
})"
AWAITING_RESUME_WINNERS="$(printf '%s\n' "$AWAITING_RESUME_RESULTS" | grep -c '^true:false:ok$')"
AWAITING_RESUME_REPLAYS="$(printf '%s\n' "$AWAITING_RESUME_RESULTS" | grep -c '^true:true:ok$')"
AWAITING_RESUME_STATE="$("${PSQL[@]}" -qAt -d "$DB" -c \
  "select status || ':' || (select version from public.job_checkpoints where job_id=jobs.id) || ':' || (select count(*) from public.job_events where job_id=jobs.id and kind='job.resumed') || ':' || (select count(*) from public.audit_log where job_id=jobs.id and action='job.resumed') from public.jobs where id='89800000-0000-4000-8000-000000000005'")"
if [[ "$AWAITING_RESUME_WINNERS" != "1" || "$AWAITING_RESUME_REPLAYS" != "1" || "$AWAITING_RESUME_STATE" != "queued:2:1:1" ]]; then
  echo "Concurrent awaiting resume verification failed: results=${AWAITING_RESUME_RESULTS}, state=${AWAITING_RESUME_STATE}" >&2
  exit 1
fi

# Two operators racing the same dead letter with the same source generation
# are serialized by the row lock and CAS. Exactly one request may create the
# new delivery round and its matching audit record.
OUTBOX_REDRIVE_RESULTS="$({
  "${PSQL[@]}" -qAt -d "$DB" -c \
    "set role service_role; select (result->>'redriven') || ':' || (result->>'replayed') || ':' || coalesce(result->>'reason','ok') from (select public.redrive_job_outbox('84d00000-0000-4000-8000-000000000002',11,'pg16-redrive-race-request-a','pg16-operator-a','concurrent recovery',0) result) response" &
  "${PSQL[@]}" -qAt -d "$DB" -c \
    "set role service_role; select (result->>'redriven') || ':' || (result->>'replayed') || ':' || coalesce(result->>'reason','ok') from (select public.redrive_job_outbox('84d00000-0000-4000-8000-000000000002',11,'pg16-redrive-race-request-b','pg16-operator-b','concurrent recovery',0) result) response" &
  wait
})"
OUTBOX_REDRIVE_WINNERS="$(printf '%s\n' "$OUTBOX_REDRIVE_RESULTS" | grep -c '^true:false:ok$')"
OUTBOX_REDRIVE_LOSERS="$(printf '%s\n' "$OUTBOX_REDRIVE_RESULTS" | grep -c '^false:false:stale_lock$')"
OUTBOX_REDRIVE_STATE="$("${PSQL[@]}" -qAt -d "$DB" -c \
  "select replay_count || ':' || lock_version || ':' || (select count(*) from public.audit_log where resource_id='84d00000-0000-4000-8000-000000000002' and action='outbox.redriven') from public.job_outbox where id='84d00000-0000-4000-8000-000000000002'")"
if [[ "$OUTBOX_REDRIVE_WINNERS" != "1" || "$OUTBOX_REDRIVE_LOSERS" != "1" || "$OUTBOX_REDRIVE_STATE" != "1:12:1" ]]; then
  echo "Concurrent outbox redrive verification failed: results=${OUTBOX_REDRIVE_RESULTS}, state=${OUTBOX_REDRIVE_STATE}" >&2
  exit 1
fi

# Prove lease recovery across an actual ungraceful worker death. The first
# command commits the claim before the same psql process blocks; SIGKILL then
# leaves the row leased until its real timeout, after which a replacement
# worker must reclaim with a new fence and the dead worker's fence must fail.
"${PSQL[@]}" -qAt -d "$DB" -c \
  "set role service_role; select public.enqueue_job('89700000-0000-4000-8000-000000000001','cleanup.chaos_kill','chaos_kill','00000000-0000-4000-8000-000000000001','registered','{}'::jsonb,'chaos-kill-intent',repeat('7',64))->>'jobId'" >/dev/null
CHAOS_LOG="$(mktemp -t mychat-chaos-worker.XXXXXX)"
"${PSQL[@]}" -qAt -d "$DB" \
  -c "set role service_role; select public.claim_next_job('pg16-sigkill-worker',array['chaos_kill'],15)->>'acquired'" \
  -c "select pg_sleep(60)" >"$CHAOS_LOG" 2>&1 &
CHAOS_PID=$!

CHAOS_CLAIMED="false"
for _ in $(seq 1 50); do
  CHAOS_CLAIMED="$("${PSQL[@]}" -qAt -d "$DB" -c \
    "select (lease_owner='pg16-sigkill-worker' and lease_version=1)::text from public.jobs where id='89700000-0000-4000-8000-000000000001'")"
  [[ "$CHAOS_CLAIMED" == "true" ]] && break
  sleep 0.1
done
if [[ "$CHAOS_CLAIMED" != "true" ]]; then
  echo "SIGKILL fixture was not claimed by the worker" >&2
  exit 1
fi

kill -9 "$CHAOS_PID"
wait "$CHAOS_PID" >/dev/null 2>&1 || true
unset CHAOS_PID

CHAOS_EXPIRED="false"
for _ in $(seq 1 40); do
  CHAOS_EXPIRED="$("${PSQL[@]}" -qAt -d "$DB" -c \
    "select (lease_expires_at <= clock_timestamp())::text from public.jobs where id='89700000-0000-4000-8000-000000000001'")"
  [[ "$CHAOS_EXPIRED" == "true" ]] && break
  sleep 0.5
done
if [[ "$CHAOS_EXPIRED" != "true" ]]; then
  echo "SIGKILL fixture lease did not expire on schedule" >&2
  exit 1
fi

CHAOS_RECOVERY="$("${PSQL[@]}" -qAt -d "$DB" -c \
  "set role service_role; select (result->>'acquired') || ':' || (result->'job'->>'leaseVersion') from (select public.claim_next_job('pg16-recovery-worker',array['chaos_kill'],15) result) claimed")"
if [[ "$CHAOS_RECOVERY" != "true:2" ]]; then
  echo "SIGKILL lease recovery failed: ${CHAOS_RECOVERY}" >&2
  exit 1
fi

CHAOS_STALE_APPEND="$("${PSQL[@]}" -qAt -d "$DB" -c \
  "set role service_role; select public.append_job_events('89700000-0000-4000-8000-000000000001','pg16-sigkill-worker',1,'[{\"kind\":\"job.progress\",\"payload\":{}}]'::jsonb)->>'appended'")"
if [[ "$CHAOS_STALE_APPEND" != "false" ]]; then
  echo "SIGKILL worker's stale fence unexpectedly appended an event" >&2
  exit 1
fi
rm -f "$CHAOS_LOG"
unset CHAOS_LOG

# Two independent workers racing the only ready row must produce exactly one
# successful claim. The loser must also be unable to append with the winner's
# fencing version.
JOB_CLAIM_RESULTS="$({
  "${PSQL[@]}" -qAt -d "$DB" -c \
    "set role service_role; select public.claim_next_job('pg16-concurrent-a',array['ideal_concurrent'],120)->>'acquired'" &
  "${PSQL[@]}" -qAt -d "$DB" -c \
    "set role service_role; select public.claim_next_job('pg16-concurrent-b',array['ideal_concurrent'],120)->>'acquired'" &
  wait
})"
JOB_CLAIM_WINNERS="$(printf '%s\n' "$JOB_CLAIM_RESULTS" | grep -c '^true$')"
if [[ "$JOB_CLAIM_WINNERS" != "1" ]]; then
  echo "Concurrent job claim verification failed: ${JOB_CLAIM_RESULTS}" >&2
  exit 1
fi

JOB_WINNER="$("${PSQL[@]}" -qAt -d "$DB" -c \
  "select lease_owner from public.jobs where id='83000000-0000-4000-8000-000000000004'")"
if [[ "$JOB_WINNER" == "pg16-concurrent-a" ]]; then
  JOB_LOSER="pg16-concurrent-b"
else
  JOB_LOSER="pg16-concurrent-a"
fi
STALE_APPEND="$("${PSQL[@]}" -qAt -d "$DB" -c \
  "set role service_role; select public.append_job_events('83000000-0000-4000-8000-000000000004','${JOB_LOSER}',1,'[{\"kind\":\"job.progress\",\"payload\":{}}]'::jsonb)->>'appended'")"
if [[ "$STALE_APPEND" != "false" ]]; then
  echo "Stale job fence unexpectedly appended an event" >&2
  exit 1
fi

# Per-conversation message sequence allocation locks the conversation row, so
# concurrent inserts receive adjacent unique positions without max(seq) races.
{
  "${PSQL[@]}" -q -d "$DB" -c \
    "insert into public.messages(id,conversation_id,user_id,role,content) values ('84000000-0000-4000-8000-000000000001','80000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','user','first')" &
  "${PSQL[@]}" -q -d "$DB" -c \
    "insert into public.messages(id,conversation_id,user_id,role,content) values ('84000000-0000-4000-8000-000000000002','80000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','assistant','second')" &
  wait
}
MESSAGE_SEQUENCE_SHAPE="$("${PSQL[@]}" -qAt -d "$DB" -c \
  "select count(distinct seq)::text || ':' || (max(seq)-min(seq))::text from public.messages where id in ('84000000-0000-4000-8000-000000000001','84000000-0000-4000-8000-000000000002')")"
if [[ "$MESSAGE_SEQUENCE_SHAPE" != "2:1" ]]; then
  echo "Concurrent message sequence verification failed: ${MESSAGE_SEQUENCE_SHAPE}" >&2
  exit 1
fi

# Reproduce Supabase's extension topology before the billing cutover, then prove
# the service-only compatibility bridge is replayable and browser-inaccessible.
"${PSQL[@]}" -d "$DB" <<'SQL'
create schema if not exists extensions;
alter extension pgcrypto set schema extensions;
grant usage on schema extensions to anon, authenticated, service_role;
SQL
"${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20260713285000_pgcrypto_digest_bridge.sql" >/dev/null
"${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20260713285000_pgcrypto_digest_bridge.sql" >/dev/null
PGCRYPTO_BRIDGE_STATE="$("${PSQL[@]}" -qAt -d "$DB" -c \
  "select (to_regprocedure('public.digest(bytea,text)') is not null)::text || ':' || has_function_privilege('service_role','public.digest(bytea,text)','execute')::text || ':' || has_function_privilege('authenticated','public.digest(bytea,text)','execute')::text || ':' || has_function_privilege('anon','public.digest(bytea,text)','execute')::text")"
if [[ "$PGCRYPTO_BRIDGE_STATE" != "true:true:false:false" ]]; then
  echo "Supabase pgcrypto bridge privileges are invalid: ${PGCRYPTO_BRIDGE_STATE}" >&2
  exit 1
fi
PGCRYPTO_BRIDGE_DIGEST="$("${PSQL[@]}" -qAt -d "$DB" -c \
  "set role service_role; select encode(public.digest(convert_to('mychat','UTF8'),'sha256'),'hex')")"
if [[ ! "$PGCRYPTO_BRIDGE_DIGEST" =~ ^[0-9a-f]{64}$ ]]; then
  echo "Supabase pgcrypto bridge did not return a SHA-256 digest" >&2
  exit 1
fi
# Install the immutable billing evidence contract only after the legacy control
# plane fixtures have exercised their pre-cutover behavior. Apply it twice
# before the fixture, then once more after new append-only history exists.
"${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20260713290000_billing_reconciliation_contract.sql" >/dev/null
"${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20260713290000_billing_reconciliation_contract.sql" >/dev/null
"${PSQL[@]}" -d "$DB" -v BILLING_SETUP=1 \
  -f "$ROOT/tests/billing-reconciliation-pg16.sql" >/dev/null

# Hold the Job row before finalization, then start direct settlement from a
# second session. The historical reservation-first order deadlocks here: the
# direct path holds reservation while waiting for Job, and the deferred trigger
# holds Job while waiting for reservation. Job-first settlement lets finalization
# commit, after which the direct call can only observe the immutable replay.
BILLING_LOCK_LOG="$(mktemp)"
PGAPPNAME=mychat-billing-job-lock-order "${PSQL[@]}" -qAt -d "$DB" -c \
  "set role service_role; select public.pg16_billing_finalize_after_job_lock()" \
  >"$BILLING_LOCK_LOG" &
BILLING_LOCK_PID=$!
BILLING_JOB_LOCK_READY=0
for _ in {1..100}; do
  if [[ "$("${PSQL[@]}" -qAt -d "$DB" -c \
    "select count(*) from pg_stat_activity where application_name='mychat-billing-job-lock-order' and wait_event='PgSleep'")" == "1" ]]; then
    BILLING_JOB_LOCK_READY=1
    break
  fi
  sleep 0.05
done
if [[ "$BILLING_JOB_LOCK_READY" != "1" ]]; then
  echo "Billing Job-lock fixture did not reach its overlap point" >&2
  exit 1
fi
BILLING_SETTLEMENT_REPLAY="$(PGAPPNAME=mychat-billing-direct-settlement \
  "${PSQL[@]}" -qAt -d "$DB" -c \
  "set role service_role; select (result->>'settled') || ':' || (result->>'replayed') || ':' || coalesce(result->>'status','null') from (select public.settle_job_admission('b1291000-0000-4000-8000-000000000001','pg16.concurrent') as result) receipt")"
wait "$BILLING_LOCK_PID"
unset BILLING_LOCK_PID
BILLING_FINALIZE_RESULT="$(tr -d '[:space:]' < "$BILLING_LOCK_LOG")"
rm -f "$BILLING_LOCK_LOG"
unset BILLING_LOCK_LOG
if [[ "$BILLING_FINALIZE_RESULT" != "true:false:failed" \
   || "$BILLING_SETTLEMENT_REPLAY" != "true:true:settled" ]]; then
  echo "Billing Job-first lock order failed: finalize=${BILLING_FINALIZE_RESULT} settlement=${BILLING_SETTLEMENT_REPLAY}" >&2
  exit 1
fi

# Activation order can race, but its row-CAS head must converge on the greatest
# version and can never leave the lower version current.
BILLING_ACTIVATION_RESULTS="$({
  "${PSQL[@]}" -qAt -d "$DB" -c \
    "set role service_role; select public.pg16_activate_billing_price(2)" &
  "${PSQL[@]}" -qAt -d "$DB" -c \
    "set role service_role; select public.pg16_activate_billing_price(3)" &
  wait
})"
BILLING_ACTIVATION_INVALID="$(printf '%s\n' "$BILLING_ACTIVATION_RESULTS" \
  | grep -Ev '^(activated|rejected)$' || true)"
if [[ -n "$BILLING_ACTIVATION_INVALID" ]] \
   || [[ "$(printf '%s\n' "$BILLING_ACTIVATION_RESULTS" | grep -c '^activated$')" -lt 1 ]]; then
  echo "Concurrent price activation returned an invalid result: ${BILLING_ACTIVATION_RESULTS}" >&2
  exit 1
fi

# A refresh already in flight is rejected immediately. The cached snapshot
# remains the constant-time readiness source while the bounded scan owns lock.
PGAPPNAME=mychat-billing-reconciliation-lock "${PSQL[@]}" -q -d "$DB" -c \
  "begin; select pg_advisory_xact_lock(5720260713290000); select pg_sleep(2); commit" \
  >/dev/null &
BILLING_LOCK_PID=$!
BILLING_LOCK_READY=0
for _ in {1..100}; do
  if [[ "$("${PSQL[@]}" -qAt -d "$DB" -c \
    "select count(*) from pg_stat_activity where application_name='mychat-billing-reconciliation-lock' and wait_event='PgSleep'")" == "1" ]]; then
    BILLING_LOCK_READY=1
    break
  fi
  sleep 0.05
done
if [[ "$BILLING_LOCK_READY" != "1" ]]; then
  echo "Billing reconciliation lock fixture did not reach its overlap point" >&2
  exit 1
fi
BILLING_BUSY_RESULT="$("${PSQL[@]}" -qAt -d "$DB" -c \
  "set role service_role; select public.pg16_refresh_billing_snapshot()")"
if [[ "$BILLING_BUSY_RESULT" != "busy" ]]; then
  echo "Concurrent billing reconciliation was not rejected: ${BILLING_BUSY_RESULT}" >&2
  exit 1
fi
wait "$BILLING_LOCK_PID"
unset BILLING_LOCK_PID

"${PSQL[@]}" -d "$DB" -v BILLING_VERIFY=1 \
  -f "$ROOT/tests/billing-reconciliation-pg16.sql" >/dev/null
"${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20260713290000_billing_reconciliation_contract.sql" >/dev/null
BILLING_REPLAY_HEALTH="$("${PSQL[@]}" -qAt -d "$DB" -c \
  "set role service_role; select public.runtime_healthcheck_v13()")"
if [[ "$BILLING_REPLAY_HEALTH" != "t" ]]; then
  echo "Billing contract replay did not preserve release readiness" >&2
  exit 1
fi

# Bind every recovery checkpoint to its pending immutable accounting delta. The
# fixture proves replay/conflict behavior, rollback atomicity, exact two-attempt
# settlement, and max-attempt SIGKILL settlement before a final migration replay.
"${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20260713300000_atomic_checkpoint_accounting.sql" >/dev/null
"${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20260713300000_atomic_checkpoint_accounting.sql" >/dev/null
"${PSQL[@]}" -d "$DB" -f "$ROOT/tests/atomic-checkpoint-accounting-pg16.sql" >/dev/null
"${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20260713300000_atomic_checkpoint_accounting.sql" >/dev/null
ATOMIC_CHECKPOINT_REPLAY_HEALTH="$("${PSQL[@]}" -qAt -d "$DB" -c \
  "set role service_role; select public.runtime_healthcheck_v14()")"
if [[ "$ATOMIC_CHECKPOINT_REPLAY_HEALTH" != "t" ]]; then
  echo "Atomic checkpoint/accounting replay did not preserve v14 readiness" >&2
  exit 1
fi

# Seal the complete repository migration manifest only after v14 is healthy.
# Replay must be idempotent, while every mismatched tuple and unauthorized role
# remains fail-closed.
CONTRACT_VERSION="$(node -e \
  "process.stdout.write(String(require(process.argv[1]).contractVersion))" \
  "$ROOT/supabase/migrations.manifest.json")"
CONTRACT_DIGEST="$(node -e \
  "process.stdout.write(require(process.argv[1]).contractDigest)" \
  "$ROOT/supabase/migrations.manifest.json")"
CONTRACT_MIGRATION_COUNT="$(node -e \
  "process.stdout.write(String(require(process.argv[1]).migrationCount))" \
  "$ROOT/supabase/migrations.manifest.json")"
"${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20260713310000_schema_contract_attestation.sql" >/dev/null
"${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/migrations/20260713310000_schema_contract_attestation.sql" >/dev/null

SCHEMA_CONTRACT_RESULT="$("${PSQL[@]}" -qAt -d "$DB" -c \
  "set role service_role; select public.verify_schema_contract_v1(${CONTRACT_VERSION}, '${CONTRACT_DIGEST}', ${CONTRACT_MIGRATION_COUNT})")"
if [[ "$SCHEMA_CONTRACT_RESULT" != "t" ]]; then
  echo "Exact schema contract attestation was not accepted" >&2
  exit 1
fi
for mismatch in \
  "$((CONTRACT_VERSION + 1)) '${CONTRACT_DIGEST}' ${CONTRACT_MIGRATION_COUNT}" \
  "${CONTRACT_VERSION} '$(printf '0%.0s' {1..64})' ${CONTRACT_MIGRATION_COUNT}" \
  "${CONTRACT_VERSION} '${CONTRACT_DIGEST}' $((CONTRACT_MIGRATION_COUNT + 1))"; do
  read -r version digest count <<<"$mismatch"
  result="$("${PSQL[@]}" -qAt -d "$DB" -c \
    "set role service_role; select public.verify_schema_contract_v1(${version}, ${digest}, ${count})")"
  if [[ "$result" != "f" ]]; then
    echo "Mismatched schema contract was accepted: $mismatch" >&2
    exit 1
  fi
done

SCHEMA_CONTRACT_ROWS="$("${PSQL[@]}" -qAt -d "$DB" -c \
  "select count(*) from public.schema_contract_attestations")"
if [[ "$SCHEMA_CONTRACT_ROWS" != "1" ]]; then
  echo "Schema contract replay created unexpected attestation rows" >&2
  exit 1
fi
SCHEMA_CONTRACT_DIRECT_GRANTS="$("${PSQL[@]}" -qAt -d "$DB" -c \
  "select count(*) from (values ('anon'), ('authenticated'), ('service_role')) roles(name) where has_table_privilege(name, 'public.schema_contract_attestations', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')")"
if [[ "$SCHEMA_CONTRACT_DIRECT_GRANTS" != "0" ]]; then
  echo "A runtime role has direct schema attestation table privileges" >&2
  exit 1
fi
for role in anon authenticated; do
  if "${PSQL[@]}" -qAt -d "$DB" -c \
    "set role ${role}; select public.verify_schema_contract_v1(${CONTRACT_VERSION}, '${CONTRACT_DIGEST}', ${CONTRACT_MIGRATION_COUNT})" \
    >/dev/null 2>&1; then
    echo "$role can execute the service-only schema contract RPC" >&2
    exit 1
  fi
done
for mutation in \
  "update public.schema_contract_attestations set migration_count = migration_count" \
  "delete from public.schema_contract_attestations"; do
  if "${PSQL[@]}" -qAt -d "$DB" -c "$mutation" >/dev/null 2>&1; then
    echo "Schema contract attestation accepted a forbidden mutation" >&2
    exit 1
  fi
done

echo "PostgreSQL generation migration verification passed"
