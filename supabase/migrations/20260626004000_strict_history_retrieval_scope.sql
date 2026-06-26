drop function if exists public.match_conversation_chunks(vector(1536), uuid, uuid, integer, double precision);
drop function if exists public.match_conversation_chunks_text(text, uuid, uuid, integer);

create function public.match_conversation_chunks(
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
    and c.embedding is not null
    and (1 - (c.embedding <=> query_embedding)) >= similarity_threshold
    and (
      (match_project_id is null and c.project_id is null)
      or (match_project_id is not null and c.project_id = match_project_id)
    )
  order by c.embedding <=> query_embedding, c.created_at desc
  limit match_count;
$$;

create function public.match_conversation_chunks_text(
  query_text text,
  match_user_id uuid,
  match_project_id uuid default null,
  match_count integer default 12
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
  with q as (
    select nullif(trim(query_text), '')::text as raw_query
  ), parsed as (
    select to_tsquery('simple', raw_query) as ts_query
    from q
    where raw_query is not null
  )
  select
    c.id,
    c.conversation_id,
    c.conversation_title,
    c.project_id,
    c.message_start_id,
    c.message_end_id,
    c.content,
    ts_rank_cd(to_tsvector('simple', c.content), p.ts_query)::double precision as similarity,
    c.created_at
  from public.conversation_chunks c
  cross join parsed p
  where c.user_id = match_user_id
    and to_tsvector('simple', c.content) @@ p.ts_query
    and (
      (match_project_id is null and c.project_id is null)
      or (match_project_id is not null and c.project_id = match_project_id)
    )
  order by ts_rank_cd(to_tsvector('simple', c.content), p.ts_query) desc, c.created_at desc
  limit match_count;
$$;

comment on function public.match_conversation_chunks is 'Strict scoped semantic retrieval. null project means ordinary Chat only; project id means that project only.';
comment on function public.match_conversation_chunks_text is 'Strict scoped keyword retrieval. null project means ordinary Chat only; project id means ordinary project only.';
