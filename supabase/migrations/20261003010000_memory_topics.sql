-- Memory entries are grouped into editable topics, matching the mobile
-- settings experience. Existing rows remain visible in the General topic.
begin;

alter table public.memories
  add column if not exists topic text not null default 'General';

alter table public.project_memories
  add column if not exists topic text not null default 'General';

update public.memories
set topic = 'General'
where topic is null or btrim(topic) = '';

update public.project_memories
set topic = 'General'
where topic is null or btrim(topic) = '';

create index if not exists memories_user_topic_updated_idx
  on public.memories(user_id, topic, updated_at desc);

create index if not exists project_memories_user_project_topic_updated_idx
  on public.project_memories(user_id, project_id, topic, updated_at desc);

commit;
