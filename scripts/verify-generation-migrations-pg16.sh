#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DB="mychat_generation_migration_test"
PSQL=(psql -v ON_ERROR_STOP=1)

cleanup() {
  "${PSQL[@]}" -d postgres -c "drop database if exists ${DB}" >/dev/null
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

echo "PostgreSQL generation migration verification passed"
