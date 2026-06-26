alter table public.conversation_chunks
  alter column embedding drop not null;

create or replace function public.match_conversation_chunks_text(
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
      match_project_id is null
      or c.project_id = match_project_id
      or c.project_id is null
    )
  order by
    case when match_project_id is not null and c.project_id = match_project_id then 0 else 1 end,
    ts_rank_cd(to_tsvector('simple', c.content), p.ts_query) desc,
    c.created_at desc
  limit match_count;
$$;

comment on function public.match_conversation_chunks_text is 'Keyword fallback for active history retrieval when semantic retrieval is weak or unavailable.';
