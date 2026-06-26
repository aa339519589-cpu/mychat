create table if not exists public.artifacts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  conversation_id uuid references public.conversations(id) on delete cascade,
  message_id uuid references public.messages(id) on delete cascade,
  project_id uuid references public.projects(id) on delete set null,
  title text not null default '未命名作品',
  raw text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (message_id)
);

create index if not exists artifacts_user_created_idx
  on public.artifacts(user_id, created_at desc);

create index if not exists artifacts_conversation_idx
  on public.artifacts(conversation_id, created_at desc);

create index if not exists artifacts_project_idx
  on public.artifacts(project_id, created_at desc);

alter table public.artifacts enable row level security;

drop policy if exists artifacts_select_own on public.artifacts;
create policy artifacts_select_own
  on public.artifacts for select
  using (auth.uid() = user_id);

drop policy if exists artifacts_insert_own on public.artifacts;
create policy artifacts_insert_own
  on public.artifacts for insert
  with check (auth.uid() = user_id);

drop policy if exists artifacts_update_own on public.artifacts;
create policy artifacts_update_own
  on public.artifacts for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists artifacts_delete_own on public.artifacts;
create policy artifacts_delete_own
  on public.artifacts for delete
  using (auth.uid() = user_id);

comment on table public.artifacts is 'Saved panel Artifacts only. Inline SVG, formula, Vega, Mermaid and function-plot shortcut renderings are intentionally not saved here.';
