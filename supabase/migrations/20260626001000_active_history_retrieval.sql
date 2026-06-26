create extension if not exists vector;

create table if not exists public.conversation_chunks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  project_id uuid null references public.projects(id) on delete set null,
  conversation_title text,
  message_start_id uuid null references public.messages(id) on delete set null,
  message_end_id uuid null references public.messages(id) on delete set null,
  content text not null,
  content_hash text not null,
  token_count integer not null default 0,
  embedding vector(1536) not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, content_hash)
);

create index if not exists conversation_chunks_user_idx
  on public.conversation_chunks(user_id, created_at desc);

create index if not exists conversation_chunks_conversation_idx
  on public.conversation_chunks(conversation_id, created_at desc);

create index if not exists conversation_chunks_project_idx
  on public.conversation_chunks(project_id, created_at desc);

create index if not exists conversation_chunks_embedding_hnsw_idx
  on public.conversation_chunks using hnsw (embedding vector_cosine_ops);

create index if not exists conversation_chunks_content_fts_idx
  on public.conversation_chunks using gin (to_tsvector('simple', content));

alter table public.conversation_chunks enable row level security;

drop policy if exists conversation_chunks_select_own on public.conversation_chunks;
create policy conversation_chunks_select_own
  on public.conversation_chunks for select
  using (auth.uid() = user_id);

drop policy if exists conversation_chunks_insert_own on public.conversation_chunks;
create policy conversation_chunks_insert_own
  on public.conversation_chunks for insert
  with check (auth.uid() = user_id);

drop policy if exists conversation_chunks_update_own on public.conversation_chunks;
create policy conversation_chunks_update_own
  on public.conversation_chunks for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists conversation_chunks_delete_own on public.conversation_chunks;
create policy conversation_chunks_delete_own
  on public.conversation_chunks for delete
  using (auth.uid() = user_id);

create or replace function public.match_conversation_chunks(
  query_embedding vector(1536),
  match_user_id uuid,
  match_project_id uuid default null,
  match_count integer default 12,
  similarity_threshold double precision default 0.28
)
returns table (
  id uuid,
  conversation_id uuid,
  conversation_title text,
  project_id uuid,
  message_start_id uuid,
  message_end_id uuid,
  content text,
  similarity double precision,
  created_at timestamptz
)
language sql
stable
as $$
  select
    c.id,
    c.conversation_id,
    c.conversation_title,
    c.project_id,
    c.message_start_id,
    c.message_end_id,
    c.content,
    1 - (c.embedding <=> query_embedding) as similarity,
    c.created_at
  from public.conversation_chunks c
  where c.user_id = match_user_id
    and (1 - (c.embedding <=> query_embedding)) >= similarity_threshold
    and (
      match_project_id is null
      or c.project_id = match_project_id
      or c.project_id is null
    )
  order by
    case when match_project_id is not null and c.project_id = match_project_id then 0 else 1 end,
    c.embedding <=> query_embedding,
    c.created_at desc
  limit match_count;
$$;

comment on table public.conversation_chunks is 'Semantic chunks of historical conversations for active retrieval. Not Memory, not Project memory.';
comment on function public.match_conversation_chunks is 'Returns semantically similar historical conversation chunks for the current user.';
